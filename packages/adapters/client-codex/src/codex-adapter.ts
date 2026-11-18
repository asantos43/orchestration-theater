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
  type ProcessModel,
  type QuotaProbe,
  type RawUpdate,
  type RolePolicy,
  type SessionSetup,
  type TransportId,
} from '@otheater/core';
import { CodexModelCatalog, type CodexConfigSource } from './model-catalog.js';
import {
  CODEX_CONFIG_IDS,
  DEFAULT_ALLOWED_MODES,
  DEFAULT_INITIAL_MODE,
  SANDBOX_OF,
  modeRefusal,
  modePolicyOf,
  type ModePolicy,
} from './modes.js';
import { normalizeCodexError, normalizeCodexUpdate } from './normalize.js';
import { modeVetoProbe, pinnedModeProbe, type ReadSessionMode } from './probes.js';
import {
  APPROVAL_POLICIES,
  CREDENTIALS_STORES,
  writeProfileConfig,
  type ApprovalPolicy,
  type CredentialsStore,
} from './profile.js';
import { CodexQuotaProbe } from './quota-probe.js';

/** What starts the client: `codex-acp` (^2.6.0), which talks to `codex app-server`. */
export const DEFAULT_CODEX_COMMAND = { cmd: 'codex-acp', args: [] as readonly string[] } as const;

/**
 * Names of the npm package that holds the ACP adapter `command` starts: the one whose
 * `package.json` gives the version of the client (N63), because it is also the program that
 * answers the ACP `initialize` (Phase 0: `agentInfo` = `@agentclientprotocol/codex-acp` 2.6.0 [V]).
 * Never a dependency of this package (level C, N45): only a name to look for.
 */
export const CODEX_ACP_PACKAGES: readonly string[] = ['@agentclientprotocol/codex-acp'];

/**
 * Options of the Codex adapter. Every default here is a configuration key with more than one
 * value, to be wired by the composition root. [proposta] key names, `clients.codex.*`.
 */
export interface CodexAdapterOptions extends ClientAdapterOptions {
  /** `clients.codex.command`. Default `codex-acp` with no arguments; the path of a binary or `node` plus a script also work. */
  readonly command?: { readonly cmd: string; readonly args: readonly string[] };
  /**
   * `clients.codex.process_model`. Default `multi-session`, what Phase 0 measured (one `codex-acp`,
   * one app-server, N sessions: 3 in parallel worked). The base shares one process per profile up
   * to `sessionsPerProcess` sessions, or leaves the processes to the pool above it.
   */
  readonly processModel?: ProcessModel;
  /** `clients.codex.initial_mode`: `workspace-write` (default) or `read-only`. Never `agent` or `agent-full-access`. */
  readonly initialMode?: string;
  /** `clients.codex.allowed_modes`: the modes `setConfig('mode', ...)` may select. Default `read-only` and `workspace-write`. */
  readonly allowedModes?: readonly string[];
  /** `clients.codex.credentials_store`: `file` (default), `keyring` or `auto`, written to the profile's `config.toml`. */
  readonly credentialsStore?: CredentialsStore;
  /** `clients.codex.approval_policy`: `on-request` (default) or `untrusted`. */
  readonly approvalPolicy?: ApprovalPolicy;
  /** `clients.codex.suggested_effort`: the effort the setup assistant proposes. Default `high`. */
  readonly suggestedEffort?: string;
  /** Where the model catalog reads the config options of a profile (a `session/new`). Without it `models.list` rejects. */
  readonly modelSource?: CodexConfigSource;
  /** How the pinned-mode probe reads the mode of a fresh session. Without it the probe fails, honestly. */
  readonly readSessionMode?: ReadSessionMode;
}

const ALL_FIELDS_NONE: Enforcement = {
  nativeTools: [],
  nativeShell: [],
  mcpServers: [],
  mcpTools: [],
  onAsk: [],
  bypass: [],
  writeScope: [],
  network: [],
};

/**
 * The `ClientAdapter` of Codex (architecture 5.2, 5.8). It translates the neutral policy into
 * what `codex-acp` takes: `CODEX_HOME` as the profile, the pinned session mode, `config.toml`, and
 * the normalizers of its updates and errors. It starts nothing by itself, and the command comes
 * from the options, never from an npm dependency.
 *
 * Sandbox and permission model [V] (Phase 0, `spikes/acp-codex`):
 * - `workspace-write` asks the client for what is outside the worktree and `/tmp`; the policy
 *   answers `reject_once` (layer 2).
 * - `agent` sends the escalation to an automatic reviewer and nothing reaches the client;
 *   `agent-full-access` asks for nothing. The adapter never asks for them and refuses to select
 *   them, so `bypass` is guaranteed by `daemon` (the veto).
 */
export class CodexAdapter extends ClientAdapter {
  readonly id = 'codex';
  readonly processModel: ProcessModel;
  readonly quota: QuotaProbe = new CodexQuotaProbe();
  readonly models: ModelCatalog;
  readonly capabilities: ClientCapabilities = {
    loadSession: true,
    mcpHttp: true,
    configOptions: ['model', 'thought_level', 'mode'],
    headless: true,
    extensions: [],
    // The `initialize` of codex-acp 2.6.0 answers `promptCapabilities.image` [V: spike of Phase 0, 2026-11-14,
    // recorded in spikes/acp-codex/README.md; not run again in P10]. That is what `inputTypes` says:
    // the image reaches the model as an MCP `image` block of a tool result (`read_attachment`,
    // `browser_screenshot`); that a client shows such a block to the model is [N] until the
    // optional real test (P10).
    inputTypes: ['image'],
  };

  readonly #command: { readonly cmd: string; readonly args: readonly string[] };
  readonly #modes: ModePolicy;
  readonly #credentialsStore: CredentialsStore;
  readonly #approvalPolicy: ApprovalPolicy;
  readonly #readSessionMode: ReadSessionMode | undefined;

  constructor(options: CodexAdapterOptions) {
    super(options);
    this.#command = options.command ?? DEFAULT_CODEX_COMMAND;
    this.processModel = options.processModel ?? 'multi-session';
    this.#modes = modePolicyOf(
      options.initialMode ?? DEFAULT_INITIAL_MODE,
      options.allowedModes ?? DEFAULT_ALLOWED_MODES,
    );
    this.#credentialsStore = options.credentialsStore ?? 'file';
    this.#approvalPolicy = options.approvalPolicy ?? 'on-request';
    if (!CREDENTIALS_STORES.includes(this.#credentialsStore)) {
      throw new InvalidInput(`codex: credentials_store ${this.#credentialsStore} is not supported`);
    }
    if (!APPROVAL_POLICIES.includes(this.#approvalPolicy)) {
      throw new InvalidInput(`codex: approval_policy ${this.#approvalPolicy} is not supported`);
    }
    this.#readSessionMode = options.readSessionMode;
    this.models = new CodexModelCatalog({
      ...(options.modelSource === undefined ? {} : { source: options.modelSource }),
      ...(options.suggestedEffort === undefined
        ? {}
        : { suggestedEffort: options.suggestedEffort }),
    });
  }

  /** The same command for both transports: the headless one starts `codex` from `setup.args`. */
  protected command(): { cmd: string; args: string[] } {
    return { cmd: this.#command.cmd, args: [...this.#command.args] };
  }

  /**
   * `agent` and `agent-full-access` are vetoed and cannot be allowed by configuration; any other
   * mode is allowed only when it is in `allowedModes`. The same answer on every transport.
   */
  protected modeVeto(mode: string): string | null {
    return modeRefusal(this.#modes, mode);
  }

  protected profileEnv(profile: Profile): Record<string, string> {
    return { CODEX_HOME: profile.dir };
  }

  /** Writes `config.toml` in the profile directory and nothing else; credentials are never touched. */
  protected prepareProfile(profile: Profile): Promise<void> {
    const sandboxMode = SANDBOX_OF[this.#modes.initial];
    if (sandboxMode === undefined) {
      return Promise.reject(new InvalidInput(`codex: no sandbox for ${this.#modes.initial}`));
    }
    return writeProfileConfig(profile.dir, {
      credentialsStore: this.#credentialsStore,
      sandboxMode,
      approvalPolicy: this.#approvalPolicy,
    });
  }

  /**
   * ACP: the initial mode, applied with `session/set_config_option` after `session/new` and after
   * `session/load`, because the client creates and reloads sessions in `agent` (Phase 0) [V].
   * Headless: `codex exec --json` with the sandbox of that mode [S]; the headless transport
   * does not exist yet, and a role with MCP servers is refused because `exec` takes none per run.
   */
  protected sessionSetup(policy: RolePolicy, via: TransportId): SessionSetup {
    if (via !== 'headless') {
      return { via: 'acp', configOptions: { [CODEX_CONFIG_IDS.mode]: this.#modes.initial } };
    }
    const sandbox = SANDBOX_OF[this.#modes.initial];
    if (sandbox === undefined) {
      throw new InvalidInput(`codex: no sandbox for ${this.#modes.initial}`);
    }
    if (policy.mcpServers.length > 0) {
      throw new InvalidInput(
        `codex: headless mode cannot take the MCP servers of the role (${policy.mcpServers.join(', ')})`,
      );
    }
    return { via: 'headless', args: ['exec', '--json', '--sandbox', sandbox], env: {} };
  }

  /**
   * What the client itself guarantees. `nativeTools`, `nativeShell` and `network` have no client
   * layer: Codex cannot remove its shell or a tool, and a domain allow-list is layer 3's. They
   * stay empty, so the policy is short for them unless a sandbox covers them.
   *
   * Phase 4, P1 (policy v2): `mcpTools` and `nativeShell: 'shells'` are not translated. The
   * architecture says Codex has an enable setting per MCP server, and the profile file
   * (`config.toml`) could carry one, but no key name, no way for a server that arrives by
   * `session/new` to meet an entry of the file, and no way a call to an MCP tool is approved
   * are confirmed [N]; this step writes no key of Codex it has no source for, and the fake agent
   * cannot measure how Codex approves an MCP call. `mcpTools` has the `daemon` layer only: the
   * framework server hands the session the tools of its role alone (the grant of the attempt
   * carries the list of the policy), and a request that does reach `answerPermission` is
   * rejected whatever the policy lists. `mcpServers` is the set of servers the session was opened
   * with and nothing finer. The real optional test is where the measurement belongs.
   */
  protected enforcement(_policy: RolePolicy, via: TransportId): Enforcement {
    if (via === 'headless') {
      return {
        ...ALL_FIELDS_NONE,
        // `sessionSetup` refuses a role with MCP servers in headless mode, so the client has none.
        mcpServers: ['client'],
        mcpTools: ['client'],
        onAsk: ['client'],
        bypass: ['daemon'],
        writeScope: ['client'],
      };
    }
    return {
      ...ALL_FIELDS_NONE,
      mcpServers: ['client'],
      mcpTools: ['daemon'],
      onAsk: ['client', 'daemon'],
      bypass: ['daemon'],
      writeScope: ['client'],
    };
  }

  protected normalizeUpdate(raw: RawUpdate): NormalizedUpdate | null {
    return normalizeCodexUpdate(raw);
  }

  protected normalizeError(raw: unknown): NormalizedError {
    return normalizeCodexError(raw);
  }

  /** Model, effort and mode in the ids of the client; a mode off the allow-list never gets here (`modeVeto`). */
  protected mapConfig(want: ExecutorConfig): Record<string, string> {
    return {
      [CODEX_CONFIG_IDS.model]: want.model,
      ...(want.effort === undefined ? {} : { [CODEX_CONFIG_IDS.effort]: want.effort }),
      ...(want.mode === undefined ? {} : { [CODEX_CONFIG_IDS.mode]: want.mode }),
    };
  }

  protected extensions(): AcpExtensionHandler[] {
    return [];
  }

  protected probes(): ConformanceProbe[] {
    return [
      modeVetoProbe(this.#modes, (want) => this.configOptionsFor(want)),
      pinnedModeProbe(this.#modes, this.#readSessionMode),
    ];
  }

  login(): Promise<LoginFlow> {
    return Promise.reject(new AdapterUnavailable('codex: login arrives in Phase 5'));
  }

  logout(): Promise<void> {
    return Promise.reject(new AdapterUnavailable('codex: logout arrives in Phase 5'));
  }
}
