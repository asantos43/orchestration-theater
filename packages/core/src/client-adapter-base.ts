// SPDX-License-Identifier: MPL-2.0
import {
  AdapterUnavailable,
  InvalidInput,
  isOTheaterError,
  PermissionDenied,
  type OTheaterError,
} from './errors.js';
import { CatalogProbeSession } from './catalog-probe-session.js';
import { ModeVetoSession } from './mode-veto-session.js';
import { answerOf, answeredAs, decidePermission } from './permission-rules.js';
import type { NormalizedUpdate } from './normalized-update.js';
import type { AdapterImplements } from './ports/adapter.js';
import type {
  AgentInfo,
  AgentSession,
  McpServerRef,
  NormalizedError,
  PermissionAnswer,
  PermissionRequest,
  RawUpdate,
  SessionNormalizer,
  SessionConfigOption,
  SessionOpenParams,
  SessionSetup,
  SessionTransport,
} from './ports/agent-session.js';
import type { ConfigValue } from './normalized-update.js';
import {
  CLIENT_ADAPTER_PORT_VERSION,
  ROLE_POLICY_FIELDS,
  type ProcessReuse,
  type SessionPurpose,
  type SessionPermissions,
  type SessionStartOptions,
  type ClientAdapterContract,
  type ClientCapabilities,
  type ConformanceReport,
  type Enforcement,
  type FieldGuarantee,
  type Guarantee,
  type GuaranteeReport,
  type LoginFlow,
  type ProbeResult,
  type ProfileCli,
  type ProcessModel,
  type RolePolicy,
  type RolePolicyField,
  type SandboxCapabilities,
} from './ports/client-adapter.js';
import type { ExecutorConfig, Profile } from './ports/executor.js';
import type { ModelCatalog } from './ports/model-catalog.js';
import type { LaunchedProcess, LaunchOptions, ProcessLauncher } from './ports/process-launcher.js';
import type { QuotaProbe } from './ports/quota-probe.js';
import type { LaunchWrapper } from './ports/sandbox.js';
import {
  DEFAULT_SESSIONS_PER_PROCESS,
  SharedProcessRegistry,
  sharedProcessKey,
  type SharedCancelEscalation,
  type SharedCancelMode,
} from './shared-process.js';

/** What the answer of layer 2 takes besides the request and the policy (`SessionPermissions` and the worktree). */
interface AnswerContext extends SessionPermissions {
  readonly cwd?: string;
}

/**
 * Id of the session config option that selects the mode, in the setup of a session and in
 * `Executor.mode`. [proposta] The three clients (Claude Code, Codex, OpenCode) call it `mode`. A
 * session also marks an option as the mode with `category: 'mode'` (ACP), whatever its id; the
 * veto looks at both.
 */
export const MODE_CONFIG_ID = 'mode';

/** Id of a {@link SessionTransport}: what the descendant sees where the architecture writes `SessionTransport`. */
export type TransportId = SessionTransport['id'];

/**
 * A handler of an ACP extension method `_otheater/<resource>` that the shell exposes (architecture
 * 5.2, "Recursos únicos também viram ACP"). [proposta] The type is not defined in the architecture
 * text; this is the smallest shape that names the method and answers it.
 */
export interface AcpExtensionHandler {
  /** Method name, `_otheater/<resource>` or `_otheater/<client>/<resource>`. */
  readonly method: string;
  /** Answers the request; may return a promise. */
  handle(params: unknown): unknown;
}

/** What a conformance probe receives. [proposta] */
export interface ProbeContext {
  readonly profile: Profile;
  /** The adapter under test; a probe opens its own session through it, in a scratch worktree it makes. */
  readonly adapter: ClientAdapterContract;
}

/**
 * A short security test against the client (architecture 5.2, "Sondas de conformidade"). The common
 * ones go to the base through {@link ClientAdapterOptions.commonProbes}; each descendant adds its
 * own in `probes()`. [proposta] The type is not defined in the architecture text.
 */
export interface ConformanceProbe {
  /** Stable id, unique among the probes of one adapter. */
  readonly id: string;
  /** Resolves with the verdict; a rejection counts as a failed probe (and the report is not cached). */
  run(context: ProbeContext): Promise<Omit<ProbeResult, 'id'>>;
}

/** `security.min_layers`: layers required per field, with a default (architecture 5.2, "Garantia por campo"). */
export type MinLayers = { readonly default: number } & Partial<
  Readonly<Record<RolePolicyField, number>>
>;

/** `security.unenforced`: what to do when a field has fewer layers than required. */
export type UnenforcedMode = 'refuse' | 'warn' | 'allow';

/**
 * `security.catalog_probe`: whether the session that only reads a client's catalog is exempt from
 * the `security.unenforced` check. `allow` (default): it is, and the base warns when it used the
 * exemption; `refuse`: it goes through the check like any other session.
 */
export type CatalogProbeMode = 'allow' | 'refuse';

/** `security.conformance`: when the probes run. */
export type ConformanceMode = 'on_version_change' | 'every_start' | 'off';

/** Keeps conformance reports across restarts (the daemon plugs the Store in); the key is the adapter version. */
export interface ConformanceCache {
  get(adapterVersion: string): ConformanceReport | undefined;
  set(adapterVersion: string, report: ConformanceReport): void;
}

/**
 * Where the version of a client came from (architecture 5.2, "Versão do cliente", N63):
 * `config` is the `client_version` the user wrote, `package_json` the file of the installed
 * package (read without running anything), `initialize` what the client said in the ACP
 * `initialize`, `unknown` that nothing said.
 */
export type ClientVersionSource = 'config' | 'package_json' | 'initialize' | 'unknown';

/** The version of a client and where it came from. */
export interface ClientVersion {
  readonly version: string;
  readonly source: ClientVersionSource;
}

/** The version the base falls back to when no source knows it. */
export const UNKNOWN_CLIENT_VERSION = 'unknown';

/**
 * The version of the client behind the adapter and how it may change (N63). Without it the
 * adapter version is the fixed `adapterVersion` string.
 */
export interface ClientVersionOptions {
  /** What is known before the first session, from `client_version` or the `package.json`. */
  readonly initial: ClientVersion;
  /**
   * Whether the version the client reports in the ACP `initialize` confirms or corrects `initial`.
   * Never when `initial.source` is `config`: a version the user wrote wins over the other sources.
   * Off for `version_source: package_json | config`.
   */
  readonly confirmByInitialize: boolean;
  /** Builds the key of the conformance cache from a client version (`<adapter>+<client>.<version>`). */
  readonly adapterVersionOf: (clientVersion: string) => string;
}

/**
 * `agentInfo.version` values the base trusts as a version: a short token of the characters a
 * version uses. It becomes part of the cache key and of a log line, so anything else (empty, long,
 * with spaces or control characters) is treated as if the client had said nothing.
 */
const CLIENT_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/;

/** Is `value` a plausible client version (a short token of version characters)? What the base trusts from a client or a file. */
export function isClientVersion(value: string): boolean {
  return CLIENT_VERSION_PATTERN.test(value);
}

/** Something the base noticed and did not fail on. */
export type ClientAdapterWarning =
  | {
      /**
       * The version the client reported in the `initialize` is not the one the adapter had (read
       * from the `package.json`, or `unknown`): from now on the adapter version, and with it the
       * key of the conformance cache, follows the new one, so `on_version_change` probes run again
       * for it. Informational; carries no credential.
       */
      readonly kind: 'client_version_corrected';
      readonly clientId: string;
      readonly from: ClientVersion;
      readonly to: ClientVersion;
      readonly adapterVersion: string;
      /** The `agentInfo.name` the client gave. */
      readonly agentName: string;
    }
  | {
      readonly kind: 'unenforced';
      readonly clientId: string;
      readonly short: readonly RolePolicyField[];
    }
  | {
      readonly kind: 'conformance_probe_threw';
      readonly clientId: string;
      readonly probeId: string;
      readonly error: unknown;
    }
  | {
      /**
       * A catalog-read session ({@link SessionStartOptions.purpose}) was opened although the
       * policy is short of guarantee layers and `security.unenforced` is `refuse`:
       * `security.catalog_probe: allow` exempted it.
       */
      readonly kind: 'catalog_probe_exempt';
      readonly clientId: string;
      readonly short: readonly RolePolicyField[];
    };

// The types of the options moved to the port (`ports/client-adapter.ts`); kept here for importers
// of this module.
export type { ProcessReuse, SessionPurpose, SessionStartOptions };

/** Everything the base needs from the outside; the core reads no environment and no file (rule `core-only-zod`). */
export interface ClientAdapterOptions {
  /** Starts the client process (architecture 5.9). */
  readonly launcher: ProcessLauncher;
  /**
   * The environment every client process starts from, built by the caller. The base never reads
   * `process.env`; `profileEnv()` goes on top of it.
   */
  readonly baseEnv: Readonly<Record<string, string>>;
  /**
   * Phase 5 (P2). [proposta] The secrets of one profile as environment variables (an API key), read
   * from the vault at the moment a client process starts and added after `profileEnv()`. They go
   * only into the environment of that process: never into a file of the profile, never into a log
   * (the launch spec is not logged) and never into another profile's process. Absent or empty:
   * nothing is added.
   */
  readonly secretEnv?: (profile: Profile) => Promise<Readonly<Record<string, string>>>;
  /** Version of this adapter, the key of the conformance cache. Change it when the translation changes. */
  readonly adapterVersion: string;
  /**
   * N63. When given, the key of the conformance cache is `clientVersion.adapterVersionOf(<current
   * client version>)` and follows the version the client reports in the `initialize`;
   * `adapterVersion` is then only what the key was built from at the start (the caller passes the
   * same value). Absent: the key is `adapterVersion` and never changes.
   */
  readonly clientVersion?: ClientVersionOptions;
  /** What layer 3 offers on this machine. Default: nothing. */
  readonly sandbox?: SandboxCapabilities;
  /**
   * Layer 3 at the launch: turns the command of the client into the confined one (the `Sandbox`
   * port). Called on every `launchSpec` and on every open that starts a process, after the profile
   * files are written. Without one the client starts as built. [proposta]
   */
  readonly launchWrapper?: LaunchWrapper;
  /** Default: one layer for every field. */
  readonly minLayers?: MinLayers;
  /** Default `refuse`. */
  readonly unenforced?: UnenforcedMode;
  /**
   * Default `allow`. Whether a session opened with `purpose: 'catalog-probe'` skips the
   * `unenforced` check (`security.catalog_probe`). Work sessions are never affected. [proposta]
   */
  readonly catalogProbe?: CatalogProbeMode;
  /** Default `on_version_change`. */
  readonly conformance?: ConformanceMode;
  readonly conformanceCache?: ConformanceCache;
  /** Probes shared by every client (architecture 5.2); the descendant adds its own in `probes()`. */
  readonly commonProbes?: readonly ConformanceProbe[];
  /**
   * Turns the MCP server names of a role into the HTTP servers handed to the session. [proposta]
   * The `RolePolicy` carries names only. Without a resolver, a role that names a server is
   * refused with `InvalidInput`: a server is never dropped in silence.
   */
  readonly resolveMcpServers?: (names: readonly string[]) => readonly McpServerRef[];
  readonly onWarning?: (warning: ClientAdapterWarning) => void;
  /**
   * `multi-session` clients, when no pool above the adapter owns the processes: how many sessions
   * one process serves before another one starts. Default {@link DEFAULT_SESSIONS_PER_PROCESS}
   * (4). [proposta] A positive integer; `1` is the same as `processReuse: 'own'`.
   */
  readonly sessionsPerProcess?: number;
  /**
   * `shared` (default): the base puts the sessions of a `multi-session` client on one process per
   * profile and environment, up to `sessionsPerProcess`. `own`: one process per session, as for a
   * `process-per-session` client. [proposta] A per-call {@link SessionStartOptions.process} wins.
   */
  readonly processReuse?: ProcessReuse;
  /**
   * What cancelling a session does to the process it shares with others, when no pool above the
   * adapter owns the processes (`SharedProcessRegistry`): `escalate` (default), `always_kill` or
   * `release`; see {@link SharedCancelMode}. The daemon's pool has the same key,
   * `pool.shared_cancel`. A process of one session is always ended by the cancel. [proposta]
   */
  readonly sharedCancel?: SharedCancelMode;
  /** Called when a cancel ended a shared process; `siblings` sessions lost their connection. Must not throw. */
  readonly onSharedCancel?: (escalation: SharedCancelEscalation) => void;
}

const DEFAULT_MIN_LAYERS: MinLayers = { default: 1 };

/**
 * Layers the daemon can vouch for, per field (architecture 5.2: refusing a request does not stop a
 * tool that never asks). `mcpTools`: layer 2 rejects the request of a tool the policy does not
 * list, and the framework server hands the session only the tools of its role.
 */
const DAEMON_FIELDS: readonly RolePolicyField[] = ['onAsk', 'bypass', 'mcpTools'];

/** In-memory cache: one process lifetime. */
class MemoryConformanceCache implements ConformanceCache {
  readonly #reports = new Map<string, ConformanceReport>();
  get(adapterVersion: string): ConformanceReport | undefined {
    return this.#reports.get(adapterVersion);
  }
  set(adapterVersion: string, report: ConformanceReport): void {
    this.#reports.set(adapterVersion, report);
  }
}

/**
 * The common part of every client adapter (architecture 5.2, "ClientAdapter"; decision v0.43).
 * One level of inheritance only: this class and the concrete clients, no intermediate class. The
 * four common methods (`openSession`/`loadSession`, `answerPermission`, `guarantee`,
 * `checkConformance`) are not overridden; a client that needs different behaviour gets an object
 * passed through {@link ClientAdapterOptions} (composition). A concrete client fills in only the
 * `protected abstract` members: the translation of the policy, the command, the normalizers.
 *
 * The transport (`acp`, `headless`) is a separate object, handed to `openSession`. The base never
 * reads `process.env`, never touches a file and never imports Node.
 */
export abstract class ClientAdapter implements ClientAdapterContract {
  abstract readonly id: string;
  abstract readonly processModel: ProcessModel;
  abstract readonly quota: QuotaProbe;
  abstract readonly models: ModelCatalog;
  abstract readonly capabilities: ClientCapabilities;

  readonly implements: AdapterImplements = {
    port: 'ClientAdapter',
    range: `^${CLIENT_ADAPTER_PORT_VERSION}`,
  };

  readonly #launcher: ProcessLauncher;
  readonly #baseEnv: Readonly<Record<string, string>>;
  readonly #secretEnv: ClientAdapterOptions['secretEnv'];
  #adapterVersion: string;
  #clientVersion: ClientVersion;
  readonly #versioning: ClientVersionOptions | undefined;
  readonly #sandbox: SandboxCapabilities;
  readonly #launchWrapper: LaunchWrapper | undefined;
  readonly #minLayers: MinLayers;
  readonly #unenforced: UnenforcedMode;
  readonly #catalogProbe: CatalogProbeMode;
  readonly #conformance: ConformanceMode;
  readonly #cache: ConformanceCache;
  readonly #commonProbes: readonly ConformanceProbe[];
  readonly #resolveMcpServers: ((names: readonly string[]) => readonly McpServerRef[]) | undefined;
  readonly #onWarning: ((warning: ClientAdapterWarning) => void) | undefined;
  readonly #processReuse: ProcessReuse;
  readonly #shared: SharedProcessRegistry;
  /** `every_start` and in-flight runs: one run per adapter instance. */
  #running: Promise<ConformanceReport> | undefined;
  #startReport: ConformanceReport | undefined;

  protected constructor(options: ClientAdapterOptions) {
    this.#launcher = options.launcher;
    this.#baseEnv = options.baseEnv;
    this.#secretEnv = options.secretEnv;
    this.#versioning = options.clientVersion;
    this.#clientVersion = options.clientVersion?.initial ?? {
      version: UNKNOWN_CLIENT_VERSION,
      source: 'unknown',
    };
    this.#adapterVersion =
      options.clientVersion?.adapterVersionOf(this.#clientVersion.version) ??
      options.adapterVersion;
    this.#sandbox = options.sandbox ?? { fields: [] };
    this.#launchWrapper = options.launchWrapper;
    this.#minLayers = options.minLayers ?? DEFAULT_MIN_LAYERS;
    this.#unenforced = options.unenforced ?? 'refuse';
    this.#catalogProbe = options.catalogProbe ?? 'allow';
    this.#conformance = options.conformance ?? 'on_version_change';
    this.#cache = options.conformanceCache ?? new MemoryConformanceCache();
    this.#commonProbes = options.commonProbes ?? [];
    this.#resolveMcpServers = options.resolveMcpServers;
    this.#onWarning = options.onWarning;
    this.#processReuse = options.processReuse ?? 'shared';
    this.#shared = new SharedProcessRegistry(
      options.launcher,
      options.sessionsPerProcess ?? DEFAULT_SESSIONS_PER_PROCESS,
      {
        ...(options.sharedCancel === undefined ? {} : { sharedCancel: options.sharedCancel }),
        ...(options.onSharedCancel === undefined ? {} : { onEscalation: options.onSharedCancel }),
      },
    );
  }

  // ---- common, written once ----

  /**
   * The version of the client the adapter takes as current, and its source. It starts as the
   * `client_version` the user wrote or the one read from the `package.json`, and, when
   * {@link ClientVersionOptions.confirmByInitialize} is on, follows what the client reports in the
   * ACP `initialize` (N63). The base never runs the client to ask. `unknown` when nothing knows.
   */
  get clientVersion(): ClientVersion {
    return this.#clientVersion;
  }

  /** The key of the conformance cache now (see {@link ClientAdapterOptions.clientVersion}). */
  get adapterVersion(): string {
    return this.#adapterVersion;
  }

  /**
   * Starts the client and returns the normalized session. Order: refuse a policy that is short of
   * layers (`security.unenforced: refuse`), write the profile files, launch the process with the
   * environment the base built, hand it to the transport. If the transport fails, the whole
   * process tree is ended before the error goes up, so a failed open leaves nothing running.
   *
   * `process-per-session` clients get a process of their own. `multi-session` clients share one
   * process per profile and environment, up to `sessionsPerProcess` sessions, and another process
   * starts above that or when the caller passes `{ process: 'own' }`. A session that leaves does
   * not end a process others still use; the last one out ends the tree. The exception is a cancel
   * the client ignored, which ends the process of every session on it (`sharedCancel`, default
   * `escalate`). The sessions of a shared process all fail with `AdapterUnavailable` when it
   * dies. [proposta]
   */
  openSession(
    profile: Profile,
    policy: RolePolicy,
    cwd: string,
    via: SessionTransport,
    options?: SessionStartOptions,
  ): Promise<AgentSession> {
    return this.#start(profile, policy, cwd, via, undefined, options);
  }

  /** Same as {@link openSession} for an existing conversation (`session/load`). */
  loadSession(
    profile: Profile,
    policy: RolePolicy,
    cwd: string,
    sessionId: string,
    via: SessionTransport,
    options?: SessionStartOptions,
  ): Promise<AgentSession> {
    if (!this.capabilities.loadSession) {
      return Promise.reject(
        new AdapterUnavailable(
          `${this.id} cannot reload a conversation (capabilities.loadSession is false)`,
        ),
      );
    }
    return this.#start(profile, policy, cwd, via, sessionId, options);
  }

  /**
   * What a caller that owns the process (the daemon's session pool) needs to start the client
   * itself: refuses a policy that is short of layers, writes the profile files and returns the
   * launch options (command, working directory, environment built by the base). It starts nothing.
   * [proposta] Additive: it is the first half of {@link openSession}, so the pool can keep one
   * process for several sessions (`processModel: 'multi-session'`). `purpose` is the one of the
   * session that will open on the process (see {@link SessionStartOptions.purpose}).
   */
  async launchSpec(
    profile: Profile,
    policy: RolePolicy,
    cwd: string,
    via: TransportId = 'acp',
    purpose: SessionPurpose = 'work',
  ): Promise<LaunchOptions> {
    this.#assertGuaranteed(policy, via, purpose);
    return this.#spec(profile, policy, cwd, via);
  }

  /**
   * Opens a session on a process the caller already started (see {@link launchSpec}). The caller
   * owns the process: a failure here does not end it, and the error is normalized the same way as
   * in {@link openSession}. [proposta] Additive, for the session pool.
   */
  openSessionOn(
    process: LaunchedProcess,
    policy: RolePolicy,
    cwd: string,
    via: SessionTransport,
    options?: SessionStartOptions,
  ): Promise<AgentSession> {
    return this.#attachOwned(process, policy, cwd, via, undefined, options);
  }

  /** Same as {@link openSessionOn} for an existing conversation (`session/load`). */
  loadSessionOn(
    process: LaunchedProcess,
    policy: RolePolicy,
    cwd: string,
    sessionId: string,
    via: SessionTransport,
    options?: SessionStartOptions,
  ): Promise<AgentSession> {
    if (!this.capabilities.loadSession) {
      return Promise.reject(
        new AdapterUnavailable(
          `${this.id} cannot reload a conversation (capabilities.loadSession is false)`,
        ),
      );
    }
    return this.#attachOwned(process, policy, cwd, via, sessionId, options);
  }

  /**
   * Layer 2 of the permissions (architecture 5.8): the answer to a `session/request_permission`,
   * the same for every client.
   *
   * With `onAsk: 'reject'` it picks `reject_once`, which refuses this request and leaves no rule
   * behind in the client (`reject_always` may be written to the profile and would outlive the
   * policy that asked for it); `reject_always` only when `reject_once` is not offered; and
   * `cancelled` when no option refuses. With `onAsk: 'rules'` (Phase 4, P2) the request first goes
   * through what is always rejected (N99), then through the rules of the policy, the first match
   * deciding (see `decidePermission`); a release picks `allow_once`, never `allow_always`. Without
   * a rule that matches the answer is the rejection above. [proposta]
   *
   * `context.onDecision` hears every answer (it never changes it), and `context.resolvePath` lets
   * the check of the worktree see through symbolic links. An unknown `onAsk` rejects.
   */
  protected answerPermission(
    request: PermissionRequest,
    policy: RolePolicy,
    context: AnswerContext = {},
  ): PermissionAnswer {
    const decision = decidePermission(request, policy, {
      cwd: context.cwd ?? '/',
      ...(context.resolvePath === undefined ? {} : { resolvePath: context.resolvePath }),
    });
    // A value of `onAsk` this version does not know is a bug or a newer policy: the safe answer is
    // to cancel, without even picking the option that refuses.
    const onAsk: string = policy.onAsk;
    const known = onAsk === 'reject' || onAsk === 'rules';
    const answer: PermissionAnswer = known ? answerOf(request, decision) : { outcome: 'cancelled' };
    if (context.onDecision !== undefined) {
      try {
        context.onDecision({ ...decision, request, answered: answeredAs(request, answer) });
      } catch {
        // The observer reports; it does not decide. A failure of its own changes nothing here.
      }
    }
    return answer;
  }

  /**
   * Joins what the client guarantees by itself (`enforcement()`) with what layer 3 offers on this
   * machine, per field, and points at the fields with fewer layers than `security.min_layers`
   * (architecture 5.2, "Garantia por campo"). Pure and synchronous. The `daemon` layer counts only
   * for `onAsk`, `bypass` and `mcpTools`: refusing a request does not stop a tool that never asks.
   *
   * [proposta] The third parameter is the transport id the client enforces for (default `acp`);
   * the port signature has only `(policy, os)` and `enforcement()` depends on the transport.
   */
  guarantee(
    policy: RolePolicy,
    os: SandboxCapabilities,
    via: TransportId = 'acp',
  ): GuaranteeReport {
    const enforcement = this.enforcement(policy, via);
    const fields = {} as Record<RolePolicyField, FieldGuarantee>;
    const short: RolePolicyField[] = [];
    for (const field of ROLE_POLICY_FIELDS) {
      const layers: Guarantee[] = [];
      for (const layer of enforcement[field]) {
        if (layer === 'daemon' && !DAEMON_FIELDS.includes(field)) continue;
        if (!layers.includes(layer)) layers.push(layer);
      }
      if (os.fields.includes(field) && !layers.includes('os')) layers.push('os');
      const required = this.#minLayers[field] ?? this.#minLayers.default;
      const ok = layers.length >= required;
      fields[field] = { layers, required, ok };
      if (!ok) short.push(field);
    }
    return { fields, ok: short.length === 0, short };
  }

  /**
   * Runs the common probes and the `probes()` of the descendant (architecture 5.2, "Sondas de
   * conformidade"). The report is cached by `adapterVersion`: with `on_version_change` a version
   * already in the cache is not probed again; `every_start` probes once per adapter instance;
   * `off` runs nothing and reports success with no probes. A probe that throws is a failed probe,
   * and a report with such a probe is not cached, so a transient failure is tried again.
   * Concurrent calls share one run.
   */
  checkConformance(profile: Profile): Promise<ConformanceReport> {
    if (this.#conformance === 'off') {
      return Promise.resolve({ adapterVersion: this.#adapterVersion, ok: true, probes: [] });
    }
    if (this.#conformance === 'every_start' && this.#startReport !== undefined) {
      return Promise.resolve(this.#startReport);
    }
    if (this.#conformance === 'on_version_change') {
      const cached = this.#cache.get(this.#adapterVersion);
      if (cached !== undefined) return Promise.resolve(cached);
    }
    this.#running ??= this.#probe(profile).finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  /**
   * Maps the model, effort and mode of an Executor to the config option ids of the client
   * (`session.setConfig(id, value)`). [proposta] `openSession` has no `ExecutorConfig`, and
   * `mapConfig` is protected, so the caller gets it through here. A mode the client refuses
   * ({@link ClientAdapter.modeVeto}) rejects with `PermissionDenied` before anything is mapped, the
   * same refusal a `setConfig` of that mode gets, so the caller learns it before a session exists.
   * `via` is the transport the session will run on (default `acp`); the veto may depend on it.
   */
  configOptionsFor(want: ExecutorConfig, via: TransportId = 'acp'): Record<string, string> {
    if (want.mode !== undefined) this.#assertModeAllowed(want.mode, via);
    return this.mapConfig(want);
  }

  // ---- specific, each client fills in ----

  /**
   * Executable and arguments of the client, e.g. `npx claude-agent-acp`. `via` is the transport
   * the session will use: the command may differ between ACP and the headless exit (architecture
   * 5.2). [proposta] A client whose command is the same for both ignores it.
   */
  protected abstract command(profile: Profile, via: TransportId): { cmd: string; args: string[] };
  /** What the profile adds to the environment: `CLAUDE_CONFIG_DIR`, `CODEX_HOME`... (never a secret in clear in logs). */
  protected abstract profileEnv(profile: Profile): Record<string, string>;
  /** Layer 1 in a file: writes the settings of the profile (permissions, statusline, telemetry). */
  protected abstract prepareProfile(profile: Profile, policy: RolePolicy): Promise<void>;
  /** Layer 1 per session, for the transport asked: `session/new` content and config options, or flags and environment. */
  protected abstract sessionSetup(policy: RolePolicy, via: TransportId): SessionSetup;
  /** What the client guarantees by itself for each field of the policy, on that transport. */
  protected abstract enforcement(policy: RolePolicy, via: TransportId): Enforcement;
  /** Agent shell: turns what the client sends into the normalized update; `null` swallows it. */
  protected abstract normalizeUpdate(raw: RawUpdate, via: TransportId): NormalizedUpdate | null;
  /**
   * More normalized updates that the same raw message carries, delivered after the one of
   * {@link normalizeUpdate}. [proposta] None by default.
   */
  // The default ignores both arguments; a client that has extras reads them.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected normalizeExtraUpdates(raw: RawUpdate, via: TransportId): readonly NormalizedUpdate[] {
    return [];
  }
  /** Agent shell: quota (N42), login, stuck client. */
  protected abstract normalizeError(raw: unknown, via: TransportId): NormalizedError;
  /**
   * Model, effort and mode in the ids of the client. It only translates: a mode the client must
   * not be in is refused by {@link modeVeto} before it gets here.
   */
  protected abstract mapConfig(want: ExecutorConfig): Record<string, string>;
  /**
   * The veto of the mode (architecture 5.8, `bypass`): why the client must not be put in `mode`
   * on this transport, or `null` to allow it. The base asks before every change of mode, so a
   * refusal is `PermissionDenied` and never reaches the client: the mode of the setup of a
   * session (`sessionSetup`, on `openSession`, `loadSession`, `openSessionOn` and `loadSessionOn`),
   * `configOptionsFor`, and every `setConfig` of the session it hands out, on a shared process
   * too. Synchronous and free of side effects. The text is the reason, without the client id: the
   * base adds it. [proposta]
   *
   * It is a `protected abstract` member, not a constructor option: the veto is what the client
   * is (Codex keeps `agent` and `agent-full-access` in its catalog and cannot remove them, Claude
   * Code refuses `bypassPermissions`), and a descendant with nothing to refuse returns `null`.
   * The base owns the part that is the same for every client (which `setConfig` is a change of
   * mode, the `PermissionDenied`, the wrapper of the session), so no common method is overridden.
   */
  protected abstract modeVeto(mode: string, via: TransportId): string | null;
  /** Answers the `_otheater/<resource>` extension methods of this client. */
  protected abstract extensions(): AcpExtensionHandler[];
  /** Probes of this client, in addition to the common ones. */
  protected abstract probes(): ConformanceProbe[];
  abstract login(profile: Profile): Promise<LoginFlow>;
  abstract logout(profile: Profile): Promise<void>;
  /** See {@link ClientAdapterContract.profileCli}: optional, an adapter that has it overrides it. */
  profileCli?(profile: Profile): Promise<ProfileCli>;
  /** See {@link ClientAdapterContract.loginMode}: optional, an adapter that has it overrides it. */
  loginMode?(): LoginFlow['mode'] | undefined;

  /** See {@link ClientAdapterContract.setUpProfile}: `prepareProfile` made public. */
  setUpProfile(profile: Profile, policy: RolePolicy): Promise<void> {
    return this.prepareProfile(profile, policy);
  }

  // ---- internals ----

  async #start(
    profile: Profile,
    policy: RolePolicy,
    cwd: string,
    via: SessionTransport,
    sessionId: string | undefined,
    options: SessionStartOptions | undefined,
  ): Promise<AgentSession> {
    const purpose = options?.purpose ?? 'work';
    this.#assertGuaranteed(policy, via.id, purpose);
    const mcpServers = this.#mcpServersOf(policy, options?.mcpServers);
    // The spec is built on every open, shared process or not: the profile files and the slot the
    // descendant keeps for this policy are written per session, and the key needs the environment.
    const spec = await this.#spec(profile, policy, cwd, via.id);
    const sharing =
      this.processModel === 'multi-session' &&
      (options?.process ?? this.#processReuse) === 'shared';
    const process = sharing
      ? await this.#shared.acquire(sharedProcessKey(profile, spec), spec)
      : await this.#launcher.launch(spec);
    try {
      return await this.#attach(
        process,
        policy,
        cwd,
        via,
        sessionId,
        mcpServers,
        purpose,
        options?.permissions,
      );
    } catch (error) {
      await this.#reap(process);
      throw isOTheaterError(error) ? error : this.#unavailable(error);
    }
  }

  async #spec(
    profile: Profile,
    policy: RolePolicy,
    cwd: string,
    via: TransportId,
  ): Promise<LaunchOptions> {
    await this.prepareProfile(profile, policy);
    const { cmd, args } = this.command(profile, via);
    const secrets = (await this.#secretEnv?.(profile)) ?? {};
    const spec: LaunchOptions = {
      cmd,
      args,
      cwd,
      env: { ...this.#baseEnv, ...this.profileEnv(profile), ...secrets },
    };
    return this.#launchWrapper === undefined
      ? spec
      : this.#launchWrapper({ profile, policy, cwd, via, spec });
  }

  async #attach(
    process: LaunchedProcess,
    policy: RolePolicy,
    cwd: string,
    via: SessionTransport,
    sessionId: string | undefined,
    mcpServers: readonly McpServerRef[],
    purpose: SessionPurpose,
    permissions: SessionPermissions | undefined,
  ): Promise<AgentSession> {
    const setup = this.sessionSetup(policy, via.id);
    this.#assertSetupModes(setup, via.id);
    const params: SessionOpenParams = {
      process,
      cwd,
      setup,
      mcpServers,
      normalizer: this.#normalizer(via.id),
      onPermission: (request) => this.answerPermission(request, policy, { cwd, ...permissions }),
      extensions: this.extensions(),
      onAgentInfo: (info) => {
        this.#observeAgentInfo(info);
      },
    };
    const opened = await (sessionId === undefined
      ? via.open(params)
      : via.load({ ...params, sessionId }));
    const session = new ModeVetoSession(opened, (id, value, options) =>
      this.#modeRefusal(id, value, options, via.id),
    );
    return purpose === 'catalog-probe' ? new CatalogProbeSession(session) : session;
  }

  async #attachOwned(
    process: LaunchedProcess,
    policy: RolePolicy,
    cwd: string,
    via: SessionTransport,
    sessionId: string | undefined,
    options: SessionStartOptions | undefined,
  ): Promise<AgentSession> {
    try {
      const purpose = options?.purpose ?? 'work';
      this.#assertGuaranteed(policy, via.id, purpose);
      const mcpServers = this.#mcpServersOf(policy, options?.mcpServers);
      return await this.#attach(
        process,
        policy,
        cwd,
        via,
        sessionId,
        mcpServers,
        purpose,
        options?.permissions,
      );
    } catch (error) {
      throw isOTheaterError(error) ? error : this.#unavailable(error);
    }
  }

  /**
   * The `initialize` of a session said who the client is. With `confirmByInitialize`, a version
   * that differs from the current one (and is not what the user wrote) replaces it, and the key of
   * the conformance cache moves with it. A version that is not a plausible token is ignored.
   */
  #observeAgentInfo(info: AgentInfo): void {
    const versioning = this.#versioning;
    if (versioning?.confirmByInitialize !== true) return;
    const current = this.#clientVersion;
    if (current.source === 'config') return;
    const version = typeof info.version === 'string' ? info.version.trim() : '';
    if (!isClientVersion(version) || version === current.version) return;
    const next: ClientVersion = { version, source: 'initialize' };
    this.#clientVersion = next;
    this.#adapterVersion = versioning.adapterVersionOf(version);
    this.#warn({
      kind: 'client_version_corrected',
      clientId: this.id,
      from: current,
      to: next,
      adapterVersion: this.#adapterVersion,
      agentName: typeof info.name === 'string' ? info.name.slice(0, 100) : '',
    });
  }

  /** The mode of the setup goes to the client with `session/set_config_option`, behind the session: ask first. */
  #assertSetupModes(setup: SessionSetup, via: TransportId): void {
    if (setup.via !== 'acp') return;
    for (const [id, value] of Object.entries(setup.configOptions)) {
      const refusal = this.#modeRefusal(id, value, [], via);
      if (refusal !== undefined) throw refusal;
    }
  }

  #assertModeAllowed(mode: string, via: TransportId): void {
    const reason = this.modeVeto(mode, via);
    if (reason !== null) throw this.#refusedMode(mode, reason);
  }

  /**
   * The refusal of a `setConfig(id, value)` (or of a config of the setup), when `id` is the mode
   * option and the veto says no. `options` are the ones the session announced: an option with
   * `category: 'mode'` is the mode whatever its id.
   */
  #modeRefusal(
    id: string,
    value: ConfigValue,
    options: readonly SessionConfigOption[],
    via: TransportId,
  ): PermissionDenied | undefined {
    const isMode =
      id === MODE_CONFIG_ID ||
      options.some((option) => option.id === id && option.category === 'mode');
    if (!isMode) return undefined;
    if (typeof value !== 'string') {
      return new PermissionDenied(`${this.id}: the mode has to be one of the mode ids`);
    }
    const reason = this.modeVeto(value, via);
    return reason === null ? undefined : this.#refusedMode(value, reason);
  }

  #refusedMode(mode: string, reason: string): PermissionDenied {
    return new PermissionDenied(`${this.id}: the mode ${mode} is refused: ${reason}`);
  }

  #assertGuaranteed(policy: RolePolicy, via: TransportId, purpose: SessionPurpose): void {
    if (this.#unenforced === 'allow') return;
    const report = this.guarantee(policy, this.#sandbox, via);
    if (report.ok) return;
    if (this.#unenforced === 'warn') {
      this.#warn({ kind: 'unenforced', clientId: this.id, short: report.short });
      return;
    }
    if (purpose === 'catalog-probe' && this.#catalogProbe === 'allow') {
      // The session handed back never runs a prompt (`CatalogProbeSession`), so it is safe to let
      // it open; the daemon still hears of it.
      this.#warn({ kind: 'catalog_probe_exempt', clientId: this.id, short: report.short });
      return;
    }
    const details = report.short
      .map(
        (field) =>
          `${field} (${String(report.fields[field].layers.length)} of ${String(report.fields[field].required)})`,
      )
      .join(', ');
    throw new PermissionDenied(
      `${this.id}: the policy is short of guarantee layers for ${details}; security.unenforced is refuse`,
    );
  }

  /**
   * The MCP servers of one session: the ones the caller handed in (`extra`, each named by the
   * policy) and the other names of the policy through the resolver.
   */
  #mcpServersOf(policy: RolePolicy, extra: readonly McpServerRef[] = []): readonly McpServerRef[] {
    for (const ref of extra) {
      if (!policy.mcpServers.includes(ref.name)) {
        throw new InvalidInput(
          `${this.id}: the MCP server "${ref.name}" is not one of the role's (${policy.mcpServers.join(', ') || 'none'})`,
        );
      }
    }
    const named = policy.mcpServers.filter((name) => !extra.some((ref) => ref.name === name));
    if (named.length === 0) return [...extra];
    if (this.#resolveMcpServers === undefined) {
      throw new InvalidInput(
        `${this.id}: the role names MCP servers (${named.join(', ')}) and no resolver was given`,
      );
    }
    return [...this.#resolveMcpServers(named), ...extra];
  }

  #normalizer(via: TransportId): SessionNormalizer {
    return {
      normalizeUpdate: (raw) => this.normalizeUpdate(raw, via),
      normalizeExtraUpdates: (raw) => this.normalizeExtraUpdates(raw, via),
      normalizeError: (raw) => this.normalizeError(raw, via),
    };
  }

  async #reap(process: LaunchedProcess): Promise<void> {
    try {
      await process.killTree();
    } catch {
      // The open already failed; the error that matters is the one that goes up.
    }
  }

  #unavailable(error: unknown): OTheaterError {
    const reason = error instanceof Error ? error.message : String(error);
    return new AdapterUnavailable(`${this.id}: the session could not be opened: ${reason}`, {
      cause: error,
    });
  }

  async #probe(profile: Profile): Promise<ConformanceReport> {
    const probes = [...this.#commonProbes, ...this.probes()];
    const seen = new Set<string>();
    for (const probe of probes) {
      if (seen.has(probe.id))
        throw new InvalidInput(`${this.id}: duplicate conformance probe id ${probe.id}`);
      seen.add(probe.id);
    }
    const results: ProbeResult[] = [];
    let threw = false;
    for (const probe of probes) {
      try {
        const verdict = await probe.run({ profile, adapter: this });
        results.push({ id: probe.id, ...verdict });
      } catch (error) {
        threw = true;
        this.#warn({
          kind: 'conformance_probe_threw',
          clientId: this.id,
          probeId: probe.id,
          error,
        });
        const detail = error instanceof Error ? error.message : String(error);
        results.push({ id: probe.id, ok: false, detail: `the probe threw: ${detail}` });
      }
    }
    const report: ConformanceReport = {
      adapterVersion: this.#adapterVersion,
      ok: results.every((result) => result.ok),
      probes: results,
    };
    if (!threw) {
      if (this.#conformance === 'on_version_change') this.#cache.set(this.#adapterVersion, report);
      if (this.#conformance === 'every_start') this.#startReport = report;
    }
    return report;
  }

  #warn(warning: ClientAdapterWarning): void {
    try {
      this.#onWarning?.(warning);
    } catch {
      // A hook must not break the adapter.
    }
  }
}
