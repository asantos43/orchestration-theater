// SPDX-License-Identifier: MPL-2.0
import {
  AdapterUnavailable,
  ClientAdapter,
  InvalidInput,
  type AcpExtensionHandler,
  type ClientAdapterOptions,
  type ClientCapabilities,
  type ConformanceProbe,
  type Enforcement,
  type ExecutorConfig,
  type LoginFlow,
  type ModelCatalog,
  type NormalizedError,
  type NormalizedUpdate,
  type Profile,
  type ProfileRef,
  type ProcessModel,
  type QuotaProbe,
  type RawUpdate,
  type RolePolicy,
  type SessionSetup,
  type TransportId,
} from '@otheater/core';
import { normalizeOpenCodeError, normalizeOpenCodeUpdate } from './normalize.js';
import {
  OpenCodeModelCatalog,
  requireProfileDir,
  type OpenCodeModelCatalogOptions,
} from './model-catalog.js';
import {
  createPermissionProbe,
  UNCONFIGURED_PERMISSION_PROBE,
  type PermissionProbeOptions,
} from './permission-probe.js';
import {
  DENY_ALL_POLICY,
  opencodePermission,
  serializePermission,
  type PermissionOptions,
} from './permission.js';
import {
  DEFAULT_ISOLATION,
  ensureProfileFiles,
  isolationEnv,
  type IsolatedHome,
  type ProfileFilesOptions,
} from './profile.js';
import { OpenCodeQuotaProbe } from './quota-probe.js';

/** Version of OpenCode the Phase 0 measurements were made on (`opencode` 1.19.5 [V]). */
export const OPENCODE_PINNED_VERSION = '1.19.5';

/** Version of the translation of this adapter: change it whenever a table of this package changes. */
export const OPENCODE_ADAPTER_BASE_VERSION = '0.1.0';

/**
 * Names of the npm package of the client: its `package.json` gives the version (N63), and
 * `opencode acp` reports that same version in the `initialize` (`agentInfo` = `OpenCode` 1.19.5
 * [V]). Only an npm install has it; a standalone binary has no `package.json` and the version stays
 * `unknown` until the `initialize`. Never a dependency (level C, N45): only a name to look for.
 */
export const OPENCODE_PACKAGES: readonly string[] = ['opencode-ai'];

/**
 * `adapterVersion` for the conformance cache. The base keys its cache by this string alone, and the
 * translation holds for the client version it was measured on (architecture 5.2), so the key joins
 * both: `0.1.0+opencode.1.19.5`. [proposta] The adapter cannot read the client version here (it
 * must not run `opencode`), so whoever builds it passes the version it installed.
 */
export function opencodeAdapterVersion(clientVersion: string = OPENCODE_PINNED_VERSION): string {
  return `${OPENCODE_ADAPTER_BASE_VERSION}+opencode.${clientVersion}`;
}

/** `pool.opencode.process_model` (N56, architecture 5.2). */
export const PROCESS_MODEL_KEYS = ['per_profile', 'per_session'] as const;
export type ProcessModelKey = (typeof PROCESS_MODEL_KEYS)[number];

const PROCESS_MODELS: Readonly<Record<ProcessModelKey, ProcessModel>> = {
  per_profile: 'multi-session',
  per_session: 'process-per-session',
};

/** What `opencode.json` of the worktree may do: `disabled` sets `OPENCODE_DISABLE_PROJECT_CONFIG=1` (Phase 0, item 8 [V]). */
export type ProjectConfigMode = 'disabled' | 'enabled';

/**
 * Mode of a session whose role cannot edit. `plan` is the mode of the client that "disallows all
 * edit tools" (Phase 0, item 8 [V] for the mode list; whether its own rules win over the pinned
 * `OPENCODE_PERMISSION` was not measured [N]); `none` leaves the client's default mode.
 */
export type ReadOnlyMode = 'plan' | 'none';

export interface OpenCodeAdapterOptions extends ClientAdapterOptions {
  /**
   * [proposta] key `clients.opencode.command`. Default `opencode acp`: the executable is a tool the
   * user installs (decision N45), never a dependency of this package.
   */
  readonly command?: { readonly cmd?: string; readonly args?: readonly string[] };
  /** `pool.opencode.process_model` (N56). Default `per_profile`. */
  readonly processModel?: ProcessModelKey;
  /** [proposta] key `clients.opencode.isolation`. Default {@link DEFAULT_ISOLATION}. */
  readonly isolation?: readonly IsolatedHome[];
  /** [proposta] key `clients.opencode.profile_config`: what goes into `opencode.json` of the profile; `null` writes none. */
  readonly profileConfig?: ProfileFilesOptions['profileConfig'];
  /** [proposta] key `clients.opencode.shell_keys`. Default `['bash']` (1.19.5 [V]). */
  readonly shellKeys?: PermissionOptions['shellKeys'];
  /** [proposta] key `clients.opencode.internal_tools`. Default `['todowrite', 'todoread']`. */
  readonly internalTools?: PermissionOptions['internalTools'];
  /** [proposta] key `clients.opencode.project_config`. Default `disabled`. */
  readonly projectConfig?: ProjectConfigMode;
  /** [proposta] key `clients.opencode.read_only_mode`. Default `none`: the pinned permission is the measured mechanism. */
  readonly readOnlyMode?: ReadOnlyMode;
  /** Absolute directory of a profile, for the model catalog (the daemon knows where profiles live). */
  readonly profileDir?: (profile: ProfileRef) => string;
  /** Settings of the model catalog besides the launcher, the environment and the profile files. */
  readonly catalog?: Omit<
    OpenCodeModelCatalogOptions,
    'launcher' | 'baseEnv' | 'profileDir' | 'cmd' | 'files'
  >;
  /** How the conformance probe of the permission runs; without it the probe fails ("not run"). */
  readonly permissionProbe?: PermissionProbeOptions;
  /**
   * How long the policy of an `openSession` waits for its turn at the environment of the profile
   * before it is dropped. Default 30 s [proposta]; only a call that never reaches the launch needs it.
   */
  readonly slotTimeoutMs?: number;
}

const DEFAULT_SLOT_TIMEOUT_MS = 30_000;

/** The permission rules of one pending launch, held until `profileEnv` takes them. */
interface Slot {
  readonly permission: string;
  readonly release: () => void;
}

/**
 * The `ClientAdapter` of OpenCode (architecture 5.2, 5.7, 5.8), over `opencode acp`. What it
 * translates, and the source of each fact, is in the README of the package.
 *
 * One thing is not in the shape of the base: `profileEnv(profile)` gets no policy, and
 * `OPENCODE_PERMISSION` is the environment variable that carries it. `prepareProfile(profile,
 * policy)` is the one call that sees both, so it keeps the permission of the launch in a slot per
 * profile directory and takes the turn at it (a second `openSession` of the profile waits), and
 * `profileEnv` takes the slot out, which ends the turn. Without a slot `profileEnv` returns the
 * deny-everything permission, so a call that skipped `prepareProfile` fails closed.
 */
export class OpenCodeAdapter extends ClientAdapter {
  readonly id = 'opencode';
  readonly processModel: ProcessModel;
  readonly quota: QuotaProbe = new OpenCodeQuotaProbe();
  readonly models: ModelCatalog;
  readonly capabilities: ClientCapabilities = {
    loadSession: true,
    mcpHttp: true,
    configOptions: ['model', 'thought_level', 'mode'],
    headless: true,
    extensions: [],
    // The `initialize` of OpenCode 1.19.5 answers `promptCapabilities.image` [V: spike of Phase 0, 2026-11-14,
    // recorded in spikes/acp-opencode/README.md; not run again in P10]. That is what `inputTypes` says:
    // the image reaches the model as an MCP `image` block of a tool result (`read_attachment`,
    // `browser_screenshot`); that a client shows such a block to the model is [N] until the
    // optional real test (P10).
    inputTypes: ['image'],
  };

  readonly #options: OpenCodeAdapterOptions;
  readonly #isolation: readonly IsolatedHome[];
  readonly #files: ProfileFilesOptions;
  readonly #permissionOptions: PermissionOptions;
  readonly #probe: ConformanceProbe;
  /** Per profile directory: the end of the queue of launches waiting for their turn. */
  readonly #queues = new Map<string, Promise<void>>();
  readonly #slots = new Map<string, Slot>();

  constructor(options: OpenCodeAdapterOptions) {
    super(options);
    const key = options.processModel ?? 'per_profile';
    if (!PROCESS_MODEL_KEYS.includes(key)) {
      throw new InvalidInput(
        `pool.opencode.process_model must be one of ${PROCESS_MODEL_KEYS.join(', ')}: ${key}`,
      );
    }
    this.#options = options;
    this.processModel = PROCESS_MODELS[key];
    this.#isolation = options.isolation ?? DEFAULT_ISOLATION;
    this.#files = {
      isolation: this.#isolation,
      ...(options.profileConfig === undefined ? {} : { profileConfig: options.profileConfig }),
    };
    this.#permissionOptions = {
      ...(options.shellKeys === undefined ? {} : { shellKeys: options.shellKeys }),
      ...(options.internalTools === undefined ? {} : { internalTools: options.internalTools }),
    };
    this.#probe =
      options.permissionProbe === undefined
        ? UNCONFIGURED_PERMISSION_PROBE
        : createPermissionProbe(options.permissionProbe);
    this.models = new OpenCodeModelCatalog({
      ...options.catalog,
      launcher: options.launcher,
      baseEnv: options.baseEnv,
      profileDir: requireProfileDir(options.profileDir),
      files: this.#files,
      ...(options.command?.cmd === undefined ? {} : { cmd: options.command.cmd }),
    });
  }

  /**
   * OpenCode refuses no mode, as before the hook existed. [N] Whether a mode of the client can
   * loosen the pinned permission was not measured (see `read_only_mode`).
   */
  protected modeVeto(): string | null {
    return null;
  }

  protected command(): { cmd: string; args: string[] } {
    const command = this.#options.command;
    return { cmd: command?.cmd ?? 'opencode', args: [...(command?.args ?? ['acp'])] };
  }

  /**
   * The isolation of the profile (`XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `OPENCODE_DB`), the pinned
   * `OPENCODE_PERMISSION` and, unless `projectConfig` is `enabled`, `OPENCODE_DISABLE_PROJECT_CONFIG=1`.
   * Takes the slot `prepareProfile` left for this launch.
   */
  protected profileEnv(profile: Profile): Record<string, string> {
    const slot = this.#slots.get(profile.dir);
    this.#slots.delete(profile.dir);
    const permission =
      slot?.permission ??
      serializePermission(opencodePermission(DENY_ALL_POLICY, this.#permissionOptions));
    slot?.release();
    return {
      ...isolationEnv(profile.dir, this.#isolation),
      OPENCODE_PERMISSION: permission,
      ...(this.#options.projectConfig === 'enabled'
        ? {}
        : { OPENCODE_DISABLE_PROJECT_CONFIG: '1' }),
    };
  }

  protected async prepareProfile(profile: Profile, policy: RolePolicy): Promise<void> {
    const release = await this.#takeTurn(profile.dir);
    try {
      await ensureProfileFiles(profile.dir, this.#files);
    } catch (error) {
      release();
      throw error;
    }
    const timer = setTimeout(() => {
      if (this.#slots.get(profile.dir)?.release === release) this.#slots.delete(profile.dir);
      release();
    }, this.#options.slotTimeoutMs ?? DEFAULT_SLOT_TIMEOUT_MS);
    timer.unref();
    this.#slots.set(profile.dir, {
      permission: serializePermission(opencodePermission(policy, this.#permissionOptions)),
      release: () => {
        clearTimeout(timer);
        release();
      },
    });
  }

  protected sessionSetup(policy: RolePolicy, via: TransportId): SessionSetup {
    if (via === 'headless') {
      // [N] `opencode run --format json` was not measured. Never `--auto`: that flag approves
      // every permission that is not denied, and the pinned permission leaves `ask` for the rest.
      return { via: 'headless', args: ['run', '--format', 'json'], env: {} };
    }
    const canEdit = policy.nativeTools.includes('edit') || policy.nativeTools.includes('write');
    const mode = !canEdit && this.#options.readOnlyMode === 'plan' ? { mode: 'plan' } : {};
    return { via: 'acp', configOptions: mode };
  }

  /**
   * What the client guarantees by itself. Over ACP: the pinned permission removes the tools and
   * turns the rest into `ask` (layer 1), and `session/request_permission` is answered by layer 2.
   * `network` has no layer of the client: OpenCode has no domain allowlist, so it needs layer 3.
   * Over the headless mode there is nobody to answer a request, so `onAsk` is left with no layer
   * and `refuse` stops the session unless the operator chose otherwise [N, `opencode run` unmeasured].
   */
  protected enforcement(_policy: RolePolicy, via: TransportId): Enforcement {
    const acp = via !== 'headless';
    const ownServersOnly =
      this.#isolation.includes('config') && this.#options.projectConfig !== 'enabled';
    return {
      nativeTools: ['client'],
      nativeShell: ['client'],
      mcpServers: ownServersOnly ? ['client'] : [],
      mcpTools: ownServersOnly && acp ? ['client', 'daemon'] : ['daemon'],
      onAsk: acp ? ['client', 'daemon'] : [],
      bypass: acp ? ['client', 'daemon'] : ['client'],
      writeScope: ['client'],
      network: [],
    };
  }

  protected normalizeUpdate(raw: RawUpdate, via: TransportId): NormalizedUpdate | null {
    return normalizeOpenCodeUpdate(raw, via);
  }

  protected normalizeError(raw: unknown): NormalizedError {
    return normalizeOpenCodeError(raw);
  }

  /** `model` is the `providerID/modelID` the client lists; `effort` and `mode` are its own ids [V, Phase 0 items 2 and 8]. Model first: the efforts offered depend on it. */
  protected mapConfig(want: ExecutorConfig): Record<string, string> {
    return {
      model: want.model,
      ...(want.effort === undefined ? {} : { effort: want.effort }),
      ...(want.mode === undefined ? {} : { mode: want.mode }),
    };
  }

  protected extensions(): AcpExtensionHandler[] {
    return [];
  }

  protected probes(): ConformanceProbe[] {
    return [this.#probe];
  }

  login(): Promise<LoginFlow> {
    return Promise.reject(
      new AdapterUnavailable(
        'opencode login arrives in Phase 5; until then run the official login of the client with the environment of the profile',
      ),
    );
  }

  logout(): Promise<void> {
    return Promise.reject(
      new AdapterUnavailable(
        'opencode logout arrives in Phase 5; until then run the official logout of the client with the environment of the profile',
      ),
    );
  }

  /** Queue of the launches of one profile directory; resolves with the function that ends the turn. */
  async #takeTurn(key: string): Promise<() => void> {
    const previous = this.#queues.get(key) ?? Promise.resolve();
    let release = (): void => undefined;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => done);
    this.#queues.set(key, tail);
    void tail.then(() => {
      if (this.#queues.get(key) === tail) this.#queues.delete(key);
    });
    await previous;
    return release;
  }
}
