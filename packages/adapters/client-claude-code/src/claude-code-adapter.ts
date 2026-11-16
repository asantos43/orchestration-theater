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
import { applyAccountEnv, type AccountEnvMode } from './account-env.js';
import { normalizeClaudeError } from './normalize-error.js';
import { normalizeClaudeUpdate, type UtilizationUnit } from './normalize-update.js';
import { ClaudeModelCatalog, EFFORT_OPTION_ID, MODEL_OPTION_ID } from './model-catalog.js';
import type { ClaudeModelCatalogOptions } from './model-catalog.js';
import { acpOptions, headlessArgs, SESSION_MODE, type SettingSourcesMode } from './policy.js';
import { shCRejectProbe, type ShCRejectProbeOptions } from './probes.js';
import { writeProfileSettings } from './prepare-profile.js';
import { ClaudeQuotaProbe } from './quota-probe.js';

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

/** Version of the translation of this adapter: the key of the conformance cache. Change it with the translation. */
export const CLAUDE_CODE_ADAPTER_VERSION = '0.1.0';

/** Modes the Executor may not ask for, and why (`mapConfig`). */
const REFUSED_MODES: Readonly<Record<string, string>> = {
  bypassPermissions: 'it skips the permission requests that layer 2 answers (bypass: forbidden)',
  dontAsk: 'it is not in the mode catalog of the adapter [V] and never reaches layer 2',
  auto: 'a classifier answers the requests instead of layer 2 [N: not measured]',
};

export interface ClaudeCodeAdapterOptions extends Omit<ClientAdapterOptions, 'adapterVersion'> {
  /** Default {@link CLAUDE_CODE_ADAPTER_VERSION}. The daemon may add the version of the client it found. */
  readonly adapterVersion?: string;
  /** What starts the ACP adapter. [proposta] key `clients.claude-code.command`. Default {@link DEFAULT_COMMAND}. */
  readonly command?: { readonly cmd: string; readonly args?: readonly string[] };
  /** [proposta] key `clients.claude-code.setting_sources`. Default `none`: the profile adds no plugin, skill or MCP. */
  readonly settingSources?: SettingSourcesMode;
  /** [proposta] key `clients.claude-code.utilization_unit`. Default `ignore`: the unit is not confirmed. */
  readonly utilizationUnit?: UtilizationUnit;
  /** [proposta] key `clients.claude-code.account_env`. Default `strip`. */
  readonly accountEnv?: AccountEnvMode;
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
  readonly quota: QuotaProbe = new ClaudeQuotaProbe();
  readonly models: ModelCatalog;
  readonly capabilities: ClientCapabilities = {
    // `loadSession: true` and `mcpHttp` are in the `initialize` of the adapter. [V: Phase 0 item 2]
    loadSession: true,
    mcpHttp: true,
    configOptions: ['mode', 'model', 'thought_level'],
    // `claude -p --output-format stream-json`: the emergency exit. [V: docs/08, claude 2.1.319]
    headless: true,
    extensions: [],
  };

  readonly #command: { cmd: string; args: string[] };
  readonly #sources: SettingSourcesMode;
  readonly #utilization: UtilizationUnit;
  readonly #probe: ShCRejectProbeOptions | undefined;

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
    this.#probe = options.probe;
    this.models = new ClaudeModelCatalog(options.modelCatalog);
  }

  protected command(): { cmd: string; args: string[] } {
    return { cmd: this.#command.cmd, args: [...this.#command.args] };
  }

  /** The profile is the config directory of Claude Code (`docs/08`): login and settings live in it. */
  protected profileEnv(profile: Profile): Record<string, string> {
    return { CLAUDE_CONFIG_DIR: profile.dir };
  }

  protected prepareProfile(profile: Profile, policy: RolePolicy): Promise<void> {
    return writeProfileSettings(profile, policy);
  }

  protected sessionSetup(policy: RolePolicy, via: TransportId): SessionSetup {
    if (via === 'headless') {
      return { via: 'headless', args: headlessArgs(policy, this.#sources), env: {} };
    }
    return {
      via: 'acp',
      // The whole `_meta` of `session/new`; the options go under `claudeCode.options`. [V]
      meta: { claudeCode: { options: acpOptions(policy, this.#sources) } },
      // The adapter starts in `auto`; `default` makes every request reach layer 2. [V]
      configOptions: { mode: SESSION_MODE },
    };
  }

  /**
   * Layer 1 per field. `nativeTools`, `nativeShell` and `mcpServers` are the client's (`tools`,
   * `disallowedTools`, `strictMcpConfig`). `onAsk` has the daemon behind it (it rejects each
   * `request_permission`); `bypass` is the client's `allowDangerouslySkipPermissions: false`
   * plus the `disableBypassPermissionsMode` of the profile file. `writeScope` and `network` have
   * no key in the client: layer 3 or nothing. [V: Phase 0 item 8; architecture 5.2]
   */
  protected enforcement(): Enforcement {
    return {
      nativeTools: ['client'],
      nativeShell: ['client'],
      mcpServers: ['client'],
      onAsk: ['client', 'daemon'],
      bypass: ['client'],
      writeScope: [],
      network: [],
    };
  }

  protected normalizeUpdate(raw: RawUpdate): NormalizedUpdate | null {
    return normalizeClaudeUpdate(raw, { utilizationUnit: this.#utilization });
  }

  protected normalizeError(raw: unknown): NormalizedError {
    return normalizeClaudeError(raw);
  }

  /** `model`, `effort` and `mode` are the ids of the config options. [V: Phase 0 item 2] */
  protected mapConfig(want: ExecutorConfig): Record<string, string> {
    if (want.mode !== undefined && Object.hasOwn(REFUSED_MODES, want.mode)) {
      throw new InvalidInput(
        `${this.id}: the mode ${want.mode} is refused: ${REFUSED_MODES[want.mode] ?? ''}`,
      );
    }
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

  login(): Promise<LoginFlow> {
    return Promise.reject(new AdapterUnavailable('claude-code login arrives in Phase 5'));
  }

  logout(): Promise<void> {
    return Promise.reject(new AdapterUnavailable('claude-code logout arrives in Phase 5'));
  }
}
