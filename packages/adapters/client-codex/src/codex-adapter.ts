// SPDX-License-Identifier: MPL-2.0
import {
  AdapterUnavailable,
  ClientAdapter,
  InvalidInput,
  PermissionDenied,
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
  type ProcessLauncher,
  type ProcessModel,
  type QuotaProbe,
  type RawUpdate,
  type RolePolicy,
  type SessionSetup,
  type SessionTransport,
  type TransportId,
} from '@otheater/core';
import {
  commandOf,
  runCommand,
  startOfficialLogin,
  type CommandSpec,
  type LoginOptions,
  type LoginProbeResult,
  type LoginRun,
} from './official-login.js';
import { CodexModelCatalog, type CodexConfigSource } from './model-catalog.js';
import {
  CODEX_CONFIG_IDS,
  DEFAULT_ALLOWED_MODES,
  DEFAULT_INITIAL_MODE,
  INNER_SANDBOX_MODES,
  fullAccessPolicy,
  modeRefusal,
  modePolicyOf,
  sandboxOfMode,
  type InnerSandboxMode,
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
import { CodexQuotaProbe, type CodexQuotaProbeOptions } from './quota-probe.js';

/** What starts the client: `codex-acp` (^2.6.0), which talks to `codex app-server`. */
export const DEFAULT_CODEX_COMMAND = { cmd: 'codex-acp', args: [] as readonly string[] } as const;

/**
 * The official login of Codex, from `codex login --help` (codex-cli, read 2026-11-18) [V: the
 * subcommand and the flags exist]; what they print and when they exit is [N]. `--device-auth` is the
 * mode `device_code`; the others use the browser. Run inside the profile (`CODEX_HOME`).
 */
export const DEFAULT_LOGIN_COMMANDS: Readonly<Record<LoginFlow['mode'], CommandSpec>> = {
  browser: { cmd: 'codex', args: ['login'] },
  device_code: { cmd: 'codex', args: ['login', '--device-auth'] },
  terminal: { cmd: 'codex', args: ['login'] },
};
export const DEFAULT_LOGOUT_COMMAND: CommandSpec = { cmd: 'codex', args: ['logout'] };

/** Nothing is allowed: the session of the login probe only exists to be refused or to be closed. */
const LOGIN_PROBE_POLICY: RolePolicy = {
  nativeTools: [],
  nativeShell: 'none',
  mcpServers: [],
  mcpTools: {},
  onAsk: 'reject',
  bypass: 'forbidden',
  writeScope: 'worktree',
  network: { allow: [] },
};

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
  /**
   * `clients.codex.inner_sandbox` (N129): `keep` (default), `full_access_when_wrapped` or `nested`.
   * See {@link InnerSandboxMode}. Only `full_access_when_wrapped` changes this adapter, and only
   * when layer 3 is on (`sandbox` with fields and a `launchWrapper`); `nested` is carried out by the
   * daemon when it asks the sandbox to wrap the process.
   */
  readonly innerSandbox?: InnerSandboxMode;
  /** `clients.codex.approval_policy`: `on-request` (default) or `untrusted`. */
  readonly approvalPolicy?: ApprovalPolicy;
  /** `clients.codex.suggested_effort`: the effort the setup assistant proposes. Default `high`. */
  readonly suggestedEffort?: string;
  /** [proposta] keys `clients.codex.login.*`. Default: `codex login` (`--device-auth` for `device_code`), mode `browser`. */
  readonly login?: LoginOptions;
  /**
   * [proposta] keys `clients.codex.quota.*`: how the quota probe starts `codex app-server`.
   * `profileDir` is required to read at all: the port gives the probe only the names of the profile.
   * Without it the probe rejects with `AdapterUnavailable` and the profile stays `unknown`.
   */
  readonly quota?: CodexQuotaOptions;
  /** Where the model catalog reads the config options of a profile (a `session/new`). Without it `models.list` rejects. */
  readonly modelSource?: CodexConfigSource;
  /** How the pinned-mode probe reads the mode of a fresh session. Without it the probe fails, honestly. */
  readonly readSessionMode?: ReadSessionMode;
}

/** What the composition root gives the quota probe: the location of the profiles and the three keys. */
export type CodexQuotaOptions = Pick<
  CodexQuotaProbeOptions,
  'profileDir' | 'command' | 'timeoutMs' | 'watch' | 'windows' | 'now'
>;

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
  readonly quota: QuotaProbe;
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
  readonly #innerSandbox: InnerSandboxMode;
  readonly #credentialsStore: CredentialsStore;
  readonly #approvalPolicy: ApprovalPolicy;
  readonly #readSessionMode: ReadSessionMode | undefined;
  readonly #launcher: ProcessLauncher;
  readonly #baseEnv: Readonly<Record<string, string>>;
  readonly #loginOptions: LoginOptions;

  constructor(options: CodexAdapterOptions) {
    super(options);
    this.#command = options.command ?? DEFAULT_CODEX_COMMAND;
    this.processModel = options.processModel ?? 'multi-session';
    this.#innerSandbox = options.innerSandbox ?? 'keep';
    if (!INNER_SANDBOX_MODES.includes(this.#innerSandbox)) {
      throw new InvalidInput(`codex: inner_sandbox ${this.#innerSandbox} is not supported`);
    }
    const configured = modePolicyOf(
      options.initialMode ?? DEFAULT_INITIAL_MODE,
      options.allowedModes ?? DEFAULT_ALLOWED_MODES,
    );
    // Without layer 3 `full_access_when_wrapped` is `keep`: no sandbox of any kind is never chosen.
    const wrapped =
      options.launchWrapper !== undefined && (options.sandbox?.fields.length ?? 0) > 0;
    this.#modes =
      this.#innerSandbox === 'full_access_when_wrapped' && wrapped
        ? fullAccessPolicy(configured)
        : configured;
    this.#credentialsStore = options.credentialsStore ?? 'file';
    this.#approvalPolicy = options.approvalPolicy ?? 'on-request';
    if (!CREDENTIALS_STORES.includes(this.#credentialsStore)) {
      throw new InvalidInput(`codex: credentials_store ${this.#credentialsStore} is not supported`);
    }
    if (!APPROVAL_POLICIES.includes(this.#approvalPolicy)) {
      throw new InvalidInput(`codex: approval_policy ${this.#approvalPolicy} is not supported`);
    }
    this.#readSessionMode = options.readSessionMode;
    this.#launcher = options.launcher;
    this.#baseEnv = options.baseEnv;
    this.#loginOptions = options.login ?? {};
    this.quota = new CodexQuotaProbe({
      launcher: options.launcher,
      baseEnv: options.baseEnv,
      profileDir:
        options.quota?.profileDir ??
        ((ref) => {
          throw new AdapterUnavailable(
            `codex: no directory for the profile ${ref.client}/${ref.profile} (the quota probe was not given one)`,
          );
        }),
      ...(options.quota?.command === undefined ? {} : { command: options.quota.command }),
      ...(options.quota?.timeoutMs === undefined ? {} : { timeoutMs: options.quota.timeoutMs }),
      ...(options.quota?.watch === undefined ? {} : { watch: options.quota.watch }),
      ...(options.quota?.windows === undefined ? {} : { windows: options.quota.windows }),
      ...(options.quota?.now === undefined ? {} : { now: options.quota.now }),
      prepare: (ref, dir) =>
        this.prepareProfile({ ...ref, id: `${ref.client}/${ref.profile}`, dir }),
    });
    this.models = new CodexModelCatalog({
      ...(options.modelSource === undefined ? {} : { source: options.modelSource }),
      ...(options.suggestedEffort === undefined
        ? {}
        : { suggestedEffort: options.suggestedEffort }),
    });
  }

  /** The `clients.codex.inner_sandbox` the adapter was built with. */
  get innerSandbox(): InnerSandboxMode {
    return this.#innerSandbox;
  }

  /** The mode every session of this adapter is created in and pinned to (after `inner_sandbox`). */
  get initialMode(): string {
    return this.#modes.initial;
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
    const sandboxMode = sandboxOfMode(this.#modes.initial);
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
    const sandbox = sandboxOfMode(this.#modes.initial);
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
   * stay empty here. `guarantee()` adds the `os` layer when the sandbox lists the field in its
   * capabilities, and `sandbox-srt` lists `nativeTools` and `nativeShell` besides `writeScope` and
   * `network` (architecture 5.2: "Codex: ['os']"; owner's decision of 2026-11-17, "Sandbox
   * conta", N128). So with the sandbox on (`sandbox.mode: runtime`) the three fields have one
   * layer and pass `security.min_layers.default: 1`; without a sandbox (mode `off`, or Windows,
   * N94) they stay short and `security.unenforced: refuse` still stops the session.
   *
   * Phase 4, P1 (policy v2): `mcpTools` and `nativeShell: 'shells'` are not translated. The
   * architecture says Codex has an enable setting per MCP server, and the profile file
   * (`config.toml`) could carry one, but no key name and no way for a server that arrives by
   * `session/new` to meet an entry of the file are confirmed [N]; this step writes no key of Codex
   * it has no source for. How Codex approves an MCP call is measured [V] (spike s1b, codex-acp
   * 2.6.0, and the real round of 2026-11-17): it sends `session/request_permission` for EVERY MCP
   * call, with `kind: execute`, the same `toolCallId` as the `tool_call` that came before it, and
   * `_meta.is_mcp_tool_approval`; the names (`rawInput.server` and `rawInput.tool`) are only in that
   * `tool_call`, which the ACP transport merges into the request (`PermissionRequest.mcpTool`).
   * Layer 2 (`decidePermission`) answers it with `allow_once` when the role lists the tool in
   * `mcpServers` and `mcpTools`, whatever `onAsk` says, and with `reject` otherwise; never
   * `allow_always`, which Codex may write to its profile [proposta]. So `mcpTools` has the `daemon`
   * layer twice over: the framework server hands the session the tools of its role alone (the grant
   * of the attempt carries the list of the policy), and a call outside the role is rejected in the
   * answer. `mcpServers` is the set of servers the session was opened with and nothing finer. That
   * a session of Codex really delivers a tool through this answer stays for the real optional test.
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

  /**
   * Where the client commands run: the profile directory with `CODEX_HOME` pointing at it. The
   * `config.toml` goes in first, so the client keeps the login in the profile's file and not in a
   * keyring shared by every profile (`credentials_store`).
   */
  async #loginRun(profile: Profile): Promise<LoginRun> {
    await this.prepareProfile(profile);
    return {
      launcher: this.#launcher,
      cwd: profile.dir,
      env: { ...this.#baseEnv, ...this.profileEnv(profile) },
    };
  }

  /**
   * The official login (`codex login`, `--device-auth` in the mode `device_code`) inside the profile
   * (architecture 5.6). The URL and the code the client prints come back in the flow; the token is
   * written by the client and never read here. [N] what the command prints and whether it needs a
   * terminal.
   */
  async login(profile: Profile): Promise<LoginFlow> {
    const mode = this.#loginOptions.mode ?? 'browser';
    const where = await this.#loginRun(profile);
    return startOfficialLogin(
      where,
      commandOf(this.#loginOptions.command, DEFAULT_LOGIN_COMMANDS[mode]),
      mode,
      this.#loginOptions,
    );
  }

  /** The official logout (`codex logout`) in the profile; the client removes what it keeps. */
  async logout(profile: Profile): Promise<void> {
    const command = commandOf(this.#loginOptions.logoutCommand, DEFAULT_LOGOUT_COMMAND);
    const { code } = await runCommand(await this.#loginRun(profile), command);
    if (code !== 0) {
      throw new PermissionDenied(
        `${this.id}: the logout ended with ${code === null ? 'a signal' : `code ${String(code)}`}`,
      );
    }
  }

  /**
   * Whether the profile has a login, without reading a token: a `session/new` through `via`. An empty
   * profile answers `-32000` "Authentication required" [V: Phase 0, item 6], which is `logged_out`;
   * a session that opens is `logged_in` and is closed at once. Any other failure goes up as it is:
   * it says nothing about the login. `cwd` is where the throwaway session is opened (default: the profile directory).
   */
  async probeLogin(
    profile: Profile,
    via: SessionTransport,
    cwd: string = profile.dir,
  ): Promise<LoginProbeResult> {
    let session;
    try {
      session = await this.openSession(profile, LOGIN_PROBE_POLICY, cwd, via, {
        purpose: 'catalog-probe',
      });
    } catch (error) {
      if (this.#isAuthRequired(error)) return { state: 'logged_out', via: 'acp_session' };
      throw error;
    }
    await session.close();
    return { state: 'logged_in', via: 'acp_session' };
  }

  #isAuthRequired(error: unknown): boolean {
    const kindOf = (cause: unknown): string | undefined =>
      typeof cause === 'object' && cause !== null && 'kind' in cause
        ? String(cause.kind)
        : undefined;
    if (error instanceof PermissionDenied && kindOf(error.cause) === 'auth_required') return true;
    const raw = error instanceof Error && error.cause !== undefined ? error.cause : error;
    return normalizeCodexError(raw).kind === 'auth_required';
  }
}
