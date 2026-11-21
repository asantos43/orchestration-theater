// SPDX-License-Identifier: MPL-2.0
import { mkdir } from 'node:fs/promises';
import {
  ClientAdapter,
  PermissionDenied,
  type ProfileCli,
  type AcpExtensionHandler,
  type ClientAdapterOptions,
  type ClientOtel,
  type ClientCapabilities,
  type Clock,
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
  type ProfileRef,
  type QuotaProbe,
  type RawUpdate,
  type RolePolicy,
  type SessionSetup,
  type TransportId,
} from '@otheater/core';
import { ACCOUNT_ENV_NAMES, applyAccountEnv, type AccountEnvMode } from './account-env.js';
import {
  commandOf,
  runCommand,
  startOfficialLogin,
  type CommandSpec,
  type LoginOptions,
  type LoginProbeResult,
  type LoginRun,
} from './official-login.js';
import { normalizeClaudeError } from './normalize-error.js';
import { withClaudeOtel } from './otel.js';
import {
  normalizeClaudeUpdate,
  rateLimitExtrasOf,
  type UtilizationUnit,
} from './normalize-update.js';
import { ClaudeModelCatalog, EFFORT_OPTION_ID, MODEL_OPTION_ID } from './model-catalog.js';
import type { ClaudeModelCatalogOptions } from './model-catalog.js';
import { acpOptions, headlessArgs, sessionModeOf, type SettingSourcesMode } from './policy.js';
import { shCRejectProbe, type ShCRejectProbeOptions } from './probes.js';
import { writeProfileSettings } from './prepare-profile.js';
import { ClaudeQuotaProbe } from './quota-probe.js';
import type { QuotaStatuslineMode } from './quota-statusline.js';

/** Id of this client, as `KNOWN_CLIENT_IDS` and the configuration name it. */
export const CLAUDE_CODE_CLIENT_ID = 'claude-code';

/**
 * The command that starts the ACP adapter of Claude Code. The name of the executable is the bin
 * of `@agentclientprotocol/claude-agent-acp` [S: package metadata, not run here]; Phase 0 started
 * it as `node dist/index.js`. [proposta] The daemon sets the real command from
 * `clients.claude-code.command` (an absolute path, `npx`, a wrapper).
 */
export const DEFAULT_COMMAND: { readonly cmd: string; readonly args: readonly string[] } = {
  cmd: 'claude-agent-acp',
  args: [],
};

/**
 * Names of the npm package that holds the ACP adapter `command` starts: the one whose
 * `package.json` gives the version of the client (N63), because it is also the program that
 * answers the ACP `initialize` (Phase 0: `agentInfo` = `claude-agent-acp` 0.107.0 [V]).
 * Never a dependency of this package (level C, N45): only a name to look for in what the user installed.
 */
export const CLAUDE_CODE_ACP_PACKAGES: readonly string[] = [
  '@agentclientprotocol/claude-agent-acp',
];

/** Version of the translation of this adapter: the key of the conformance cache. Change it with the translation. */
export const CLAUDE_CODE_ADAPTER_VERSION = '0.1.0';

/** Modes the client may not be put in, and why (`modeVeto`). */
const REFUSED_MODES: Readonly<Record<string, string>> = {
  bypassPermissions: 'it skips the permission requests that layer 2 answers (bypass: forbidden)',
  dontAsk: 'it is not in the mode catalog of the adapter [V] and never reaches layer 2',
  auto: 'a classifier answers the requests instead of layer 2 [N: not measured]',
};

/**
 * The official login of Claude Code, from `claude auth --help` (claude 2.1.325, read 2026-11-18)
 * [V: the subcommands and flags exist]; what they print and when they exit is [N]. Run inside the
 * profile (`CLAUDE_CONFIG_DIR`); the adapter never opens the place the client keeps the token.
 */
export const DEFAULT_LOGIN_COMMAND: CommandSpec = {
  cmd: 'claude',
  args: ['auth', 'login', '--claudeai'],
};
export const DEFAULT_LOGOUT_COMMAND: CommandSpec = { cmd: 'claude', args: ['auth', 'logout'] };
/**
 * The common commands of `ot profile exec` (P28a, N159), from `claude --help` and `claude auth
 * --help` (claude 2.1.325, read 2026-11-19) [V: the subcommands and flags exist]. `status` asks for
 * `--text`, since the JSON is the default. `login` and `logout` are the commands of the login above.
 */
export const PROFILE_CLI_STATUS_ARGS: readonly string[] = ['auth', 'status', '--text'];
export const PROFILE_CLI_RUN_ARGS: readonly string[] = ['-p'];
/** The login probe: `claude auth status --json` [V: the command and flag exist; the JSON shape is N]. */
export const DEFAULT_STATUS_COMMAND: CommandSpec = {
  cmd: 'claude',
  args: ['auth', 'status', '--json'],
};

/** [proposta] `clients.claude-code.login`: the commands and the mode of the official login, and the probe. */
export interface ClaudeCodeLoginOptions extends LoginOptions {
  /** `clients.claude-code.login.status_command`: what the login probe runs; only its `loggedIn` field is read. */
  readonly statusCommand?: { readonly cmd: string; readonly args?: readonly string[] };
}

export interface ClaudeCodeAdapterOptions extends Omit<ClientAdapterOptions, 'adapterVersion'> {
  /** Default {@link CLAUDE_CODE_ADAPTER_VERSION}. The daemon may add the version of the client it found. */
  readonly adapterVersion?: string;
  /** What starts the ACP adapter. [proposta] key `clients.claude-code.command`. Default {@link DEFAULT_COMMAND}. */
  readonly command?: { readonly cmd: string; readonly args?: readonly string[] };
  /** [proposta] key `clients.claude-code.setting_sources`. Default `none`: the profile adds no plugin, skill or MCP. */
  readonly settingSources?: SettingSourcesMode;
  /** [proposta] key `clients.claude-code.utilization_unit`. Default `ignore`: the unit is not confirmed; `auto` is N123. */
  readonly utilizationUnit?: UtilizationUnit;
  /** [proposta] key `clients.claude-code.quota_statusline`. Default `file`: the profile settings get the quota statusline (P6). */
  readonly quotaStatusline?: QuotaStatuslineMode;
  /** The directory of a profile, where the statusline command writes and the quota probe reads. Without it the probe reads nothing. */
  readonly profileDir?: (profile: ProfileRef) => string;
  /** Clock of the quota probe (the time a reading is held back to). Default: the system clock. */
  readonly quotaClock?: Pick<Clock, 'now'>;
  /** How often the quota probe looks at the file in `watch`, in ms. */
  readonly quotaWatchEveryMs?: number;
  /** [proposta] key `clients.claude-code.account_env`. Default `strip`. */
  readonly accountEnv?: AccountEnvMode;
  /** [proposta] keys `clients.claude-code.login.*`. Default: {@link DEFAULT_LOGIN_COMMAND}, mode `browser`. */
  readonly login?: ClaudeCodeLoginOptions;
  /** [proposta] key `clients.claude-code.model_catalog` and the reader of the session. */
  readonly modelCatalog?: ClaudeModelCatalogOptions;
  /**
   * The `sh -c` probe. Without it `probes()` is empty: the probe sends a prompt, and the daemon
   * decides whether conformance may.
   */
  readonly probe?: ShCRejectProbeOptions;
}

/**
 * Claude Code through `claude-agent-acp` (architecture 5.2). Translates the neutral `RolePolicy`
 * into the keys of the client and its output into the normalized vocabulary. The common methods
 * (`openSession`, `answerPermission`, `guarantee`, `checkConformance`) are the base's.
 *
 * `processModel` is `process-per-session`: the adapter process can hold several sessions, but each
 * one starts its own `claude` (about 300 MB of RSS idle, 130 MB more for the adapter) and a
 * SIGTERM to the adapter leaves that child alive. The whole tree is what must end. [V: Phase 0
 * item 7]
 */
export class ClaudeCodeAdapter extends ClientAdapter {
  readonly id = CLAUDE_CODE_CLIENT_ID;
  readonly processModel: ProcessModel = 'process-per-session';
  readonly quota: QuotaProbe;
  readonly models: ModelCatalog;
  readonly capabilities: ClientCapabilities = {
    // `loadSession: true` and `mcpHttp` are in the `initialize` of the adapter. [V: Phase 0 item 2]
    loadSession: true,
    mcpHttp: true,
    configOptions: ['mode', 'model', 'thought_level'],
    // `claude -p --output-format stream-json`: the emergency exit. [V: docs/08, claude 2.1.319]
    headless: true,
    extensions: [],
    // The `initialize` of claude-agent-acp 0.107.0 answers `promptCapabilities.image` [V: spike of Phase 0, 2026-11-14,
    // recorded in spikes/acp-claude/README.md; not run again in P10]. That is what `inputTypes` says:
    // the image reaches the model as an MCP `image` block of a tool result (`read_attachment`,
    // `browser_screenshot`); that a client shows such a block to the model is [N] until the
    // optional real test (P10).
    inputTypes: ['image'],
  };

  readonly #command: { cmd: string; args: string[] };
  readonly #sources: SettingSourcesMode;
  readonly #utilization: UtilizationUnit;
  readonly #quotaStatusline: QuotaStatuslineMode;
  readonly #probe: ShCRejectProbeOptions | undefined;
  readonly #launcher: ProcessLauncher;
  readonly #baseEnv: Readonly<Record<string, string>>;
  readonly #loginOptions: ClaudeCodeLoginOptions;
  readonly #accountEnv: AccountEnvMode;

  constructor(options: ClaudeCodeAdapterOptions) {
    super({
      ...options,
      adapterVersion: options.adapterVersion ?? CLAUDE_CODE_ADAPTER_VERSION,
      baseEnv: applyAccountEnv(options.baseEnv, options.accountEnv),
    });
    this.#command = {
      cmd: options.command?.cmd ?? DEFAULT_COMMAND.cmd,
      args: [...(options.command?.args ?? DEFAULT_COMMAND.args)],
    };
    this.#sources = options.settingSources ?? 'none';
    this.#utilization = options.utilizationUnit ?? 'ignore';
    this.#quotaStatusline = options.quotaStatusline ?? 'file';
    this.quota = new ClaudeQuotaProbe({
      ...(options.profileDir === undefined ? {} : { profileDir: options.profileDir }),
      ...(options.quotaClock === undefined ? {} : { clock: options.quotaClock }),
      ...(options.quotaWatchEveryMs === undefined
        ? {}
        : { watchEveryMs: options.quotaWatchEveryMs }),
    });
    this.#probe = options.probe;
    this.#launcher = options.launcher;
    this.#baseEnv = applyAccountEnv(options.baseEnv, options.accountEnv);
    this.#loginOptions = options.login ?? {};
    this.#accountEnv = options.accountEnv ?? 'strip';
    this.models = new ClaudeModelCatalog(options.modelCatalog);
  }

  /** The same command for both transports: the headless one starts `claude` from `setup.args`. */
  protected command(): { cmd: string; args: string[] } {
    return { cmd: this.#command.cmd, args: [...this.#command.args] };
  }

  /** `bypassPermissions`, `dontAsk` and `auto` ({@link REFUSED_MODES}), on every transport. */
  protected modeVeto(mode: string): string | null {
    return Object.hasOwn(REFUSED_MODES, mode) ? (REFUSED_MODES[mode] ?? null) : null;
  }

  /** The profile is the config directory of Claude Code (`docs/08`): login and settings live in it. */
  protected profileEnv(profile: Profile): Record<string, string> {
    return { CLAUDE_CONFIG_DIR: profile.dir };
  }

  protected prepareProfile(profile: Profile, policy: RolePolicy): Promise<void> {
    return writeProfileSettings(profile, policy, { quotaStatusline: this.#quotaStatusline });
  }

  protected sessionSetup(policy: RolePolicy, via: TransportId): SessionSetup {
    if (via === 'headless') {
      return { via: 'headless', args: headlessArgs(policy, this.#sources), env: {} };
    }
    return {
      via: 'acp',
      // The whole `_meta` of `session/new`; the options go under `claudeCode.options`. [V]
      meta: { claudeCode: { options: acpOptions(policy, this.#sources) } },
      // The adapter starts in `auto`. `default` makes every request reach layer 2 [V]; a role that
      // writes starts in `acceptEdits` (N180). The `mode` of the executor (`mapConfig`) is applied
      // later, by `session.setConfig`, so it wins.
      configOptions: { mode: sessionModeOf(policy) },
    };
  }

  /** Telemetry of this client belongs to the session (`_meta.claudeCode.options.env`), see {@link withClaudeOtel}. */
  protected override otelSetup(setup: SessionSetup, otel: ClientOtel): SessionSetup {
    return withClaudeOtel(setup, otel);
  }

  /**
   * Layer 1 per field. `nativeTools`, `nativeShell` and `mcpServers` are the client's (`tools`,
   * `disallowedTools`, `strictMcpConfig`; the MCP tools of the role by name in `allowedTools`).
   * `nativeShell` holds for both values of the policy: `shells` is the daemon's shells, MCP tools,
   * and the native Bash is removed either way. The same answer for every role: the translation
   * of the policy changes the lists, not the layers. `onAsk` has the daemon behind it (it rejects each
   * `request_permission`); `bypass` is the client's `allowDangerouslySkipPermissions: false`
   * plus the `disableBypassPermissionsMode` of the profile file. `writeScope` and `network` have
   * no key in the client: layer 3 or nothing. [V: Phase 0 item 8; architecture 5.2]
   */
  protected enforcement(): Enforcement {
    return {
      nativeTools: ['client'],
      nativeShell: ['client'],
      mcpServers: ['client'],
      mcpTools: ['client', 'daemon'],
      onAsk: ['client', 'daemon'],
      bypass: ['client'],
      writeScope: [],
      network: [],
    };
  }

  protected normalizeUpdate(raw: RawUpdate): NormalizedUpdate | null {
    return normalizeClaudeUpdate(raw, { utilizationUnit: this.#utilization });
  }

  protected override normalizeExtraUpdates(raw: RawUpdate): readonly NormalizedUpdate[] {
    return rateLimitExtrasOf(raw, this.#utilization);
  }

  protected normalizeError(raw: unknown): NormalizedError {
    return normalizeClaudeError(raw);
  }

  /** `model`, `effort` and `mode` are the ids of the config options. [V: Phase 0 item 2] */
  protected mapConfig(want: ExecutorConfig): Record<string, string> {
    return {
      [MODEL_OPTION_ID]: want.model,
      ...(want.effort === undefined ? {} : { [EFFORT_OPTION_ID]: want.effort }),
      ...(want.mode === undefined ? {} : { mode: want.mode }),
    };
  }

  protected extensions(): AcpExtensionHandler[] {
    return [];
  }

  protected probes(): ConformanceProbe[] {
    return this.#probe === undefined ? [] : [shCRejectProbe(this.#probe)];
  }

  /** Where the client commands run: the profile directory, with the environment that points the client at it. */
  async #loginRun(profile: Profile): Promise<LoginRun> {
    await mkdir(profile.dir, { recursive: true, mode: 0o700 });
    return {
      launcher: this.#launcher,
      cwd: profile.dir,
      env: { ...this.#baseEnv, ...this.profileEnv(profile) },
    };
  }

  /** The mode `login` runs in, told without starting it (P5 of Phase 7, N186). */
  override loginMode(): LoginFlow['mode'] {
    return this.#loginOptions.mode ?? 'browser';
  }

  /**
   * The official login (`claude auth login`) inside the profile (architecture 5.6). The URL the
   * client prints comes back in the flow for the Producer to open; the token is written by the
   * client in the profile and is never read here. Mode `browser` by default; `device_code` also
   * looks for a code in the output, and `terminal` hands the flow back at once. [N] what the
   * command prints and whether it needs a terminal.
   */
  async login(profile: Profile): Promise<LoginFlow> {
    const where = await this.#loginRun(profile);
    return startOfficialLogin(
      where,
      commandOf(this.#loginOptions.command, DEFAULT_LOGIN_COMMAND),
      this.#loginOptions.mode ?? 'browser',
      this.#loginOptions,
    );
  }

  /** The official logout (`claude auth logout`) in the profile; the client removes what it keeps. */
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
   * The official CLI in the profile, for `ot profile exec` (P28a, N159): `claude` with
   * `CLAUDE_CONFIG_DIR`. Unless `account_env` is `keep`, the account variables of the terminal
   * ({@link ACCOUNT_ENV_NAMES}) go away, as they do for the sessions, so the CLI uses the login of the
   * profile; the key of an API profile comes back from the vault.
   */
  override async profileCli(profile: Profile): Promise<ProfileCli> {
    await this.#loginRun(profile);
    const login = commandOf(this.#loginOptions.command, DEFAULT_LOGIN_COMMAND);
    const logout = commandOf(this.#loginOptions.logoutCommand, DEFAULT_LOGOUT_COMMAND);
    return {
      cmd: login.cmd,
      args: [],
      env: this.profileEnv(profile),
      unsetEnv: ['CLAUDE_CONFIG_DIR', ...(this.#accountEnv === 'keep' ? [] : ACCOUNT_ENV_NAMES)],
      commands: {
        login: [...login.args],
        logout: [...logout.args],
        status: [...PROFILE_CLI_STATUS_ARGS],
        run: [...PROFILE_CLI_RUN_ARGS],
      },
      options: { model: ['--model'] },
    };
  }

  /**
   * Whether the profile has a login, without reading a token: runs the status command of the client
   * (`claude auth status --json`) and reads only the boolean `loggedIn` of its answer. `session/new` of
   * `claude-agent-acp` works without a login [V], so it cannot tell. [N] the JSON shape and the exit
   * code of a logged-out profile: an answer without that boolean is `unknown`, never `logged_in`.
   */
  async probeLogin(profile: Profile): Promise<LoginProbeResult> {
    const command = commandOf(this.#loginOptions.statusCommand, DEFAULT_STATUS_COMMAND);
    const { output } = await runCommand(await this.#loginRun(profile), command);
    const state = loggedInOf(output);
    return {
      state: state === undefined ? 'unknown' : state ? 'logged_in' : 'logged_out',
      via: 'status_command',
    };
  }
}

/** The `loggedIn` boolean of the JSON the status command prints; `undefined` when there is none. */
function loggedInOf(output: string): boolean | undefined {
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start < 0 || end < start) return undefined;
  try {
    const parsed: unknown = JSON.parse(output.slice(start, end + 1));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const flag = (parsed as { loggedIn?: unknown }).loggedIn;
    return typeof flag === 'boolean' ? flag : undefined;
  } catch {
    return undefined;
  }
}
