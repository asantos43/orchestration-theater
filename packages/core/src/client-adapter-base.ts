// SPDX-License-Identifier: MPL-2.0
import {
  AdapterUnavailable,
  InvalidInput,
  isOTheaterError,
  PermissionDenied,
  type OTheaterError,
} from './errors.js';
import type { NormalizedUpdate } from './normalized-update.js';
import type { AdapterImplements } from './ports/adapter.js';
import type {
  AgentSession,
  McpServerRef,
  NormalizedError,
  PermissionAnswer,
  PermissionRequest,
  RawUpdate,
  SessionNormalizer,
  SessionOpenParams,
  SessionSetup,
  SessionTransport,
} from './ports/agent-session.js';
import {
  CLIENT_ADAPTER_PORT_VERSION,
  ROLE_POLICY_FIELDS,
  type ClientAdapterContract,
  type ClientCapabilities,
  type ConformanceReport,
  type Enforcement,
  type FieldGuarantee,
  type Guarantee,
  type GuaranteeReport,
  type LoginFlow,
  type ProbeResult,
  type ProcessModel,
  type RolePolicy,
  type RolePolicyField,
  type SandboxCapabilities,
} from './ports/client-adapter.js';
import type { ExecutorConfig, Profile } from './ports/executor.js';
import type { ModelCatalog } from './ports/model-catalog.js';
import type { LaunchedProcess, LaunchOptions, ProcessLauncher } from './ports/process-launcher.js';
import type { QuotaProbe } from './ports/quota-probe.js';
import {
  DEFAULT_SESSIONS_PER_PROCESS,
  SharedProcessRegistry,
  sharedProcessKey,
} from './shared-process.js';

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

/** `security.conformance`: when the probes run. */
export type ConformanceMode = 'on_version_change' | 'every_start' | 'off';

/** Keeps conformance reports across restarts (the daemon plugs the Store in); the key is the adapter version. */
export interface ConformanceCache {
  get(adapterVersion: string): ConformanceReport | undefined;
  set(adapterVersion: string, report: ConformanceReport): void;
}

/** Something the base noticed and did not fail on. */
export type ClientAdapterWarning =
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
    };

/** `multi-session` reuse: `shared` puts sessions of one profile on one process, `own` gives each its own. */
export type ProcessReuse = 'shared' | 'own';

/**
 * What a caller can ask of one `openSession`/`loadSession`. [proposta] Additive: the port signature
 * has no fifth parameter, and a call without it behaves as before.
 */
export interface SessionStartOptions {
  /**
   * `own` starts a process for this session alone, even when the client is `multi-session` and a
   * shared one has room. `shared` (the default of {@link ClientAdapterOptions.processReuse}) joins
   * one. Ignored for a `process-per-session` client, which always gets its own.
   */
  readonly process?: ProcessReuse;
}

/** Everything the base needs from the outside; the core reads no environment and no file (rule `core-only-zod`). */
export interface ClientAdapterOptions {
  /** Starts the client process (architecture 5.9). */
  readonly launcher: ProcessLauncher;
  /**
   * The environment every client process starts from, built by the caller. The base never reads
   * `process.env`; `profileEnv()` goes on top of it.
   */
  readonly baseEnv: Readonly<Record<string, string>>;
  /** Version of this adapter, the key of the conformance cache. Change it when the translation changes. */
  readonly adapterVersion: string;
  /** What layer 3 offers on this machine. Default: nothing. */
  readonly sandbox?: SandboxCapabilities;
  /** Default: one layer for every field. */
  readonly minLayers?: MinLayers;
  /** Default `refuse`. */
  readonly unenforced?: UnenforcedMode;
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
}

const DEFAULT_MIN_LAYERS: MinLayers = { default: 1 };

/** Layers the daemon can vouch for, per field (architecture 5.2: refusing a request does not stop a tool that never asks). */
const DAEMON_FIELDS: readonly RolePolicyField[] = ['onAsk', 'bypass'];

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
  readonly #adapterVersion: string;
  readonly #sandbox: SandboxCapabilities;
  readonly #minLayers: MinLayers;
  readonly #unenforced: UnenforcedMode;
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
    this.#adapterVersion = options.adapterVersion;
    this.#sandbox = options.sandbox ?? { fields: [] };
    this.#minLayers = options.minLayers ?? DEFAULT_MIN_LAYERS;
    this.#unenforced = options.unenforced ?? 'refuse';
    this.#conformance = options.conformance ?? 'on_version_change';
    this.#cache = options.conformanceCache ?? new MemoryConformanceCache();
    this.#commonProbes = options.commonProbes ?? [];
    this.#resolveMcpServers = options.resolveMcpServers;
    this.#onWarning = options.onWarning;
    this.#processReuse = options.processReuse ?? 'shared';
    this.#shared = new SharedProcessRegistry(
      options.launcher,
      options.sessionsPerProcess ?? DEFAULT_SESSIONS_PER_PROCESS,
    );
  }

  // ---- common, written once ----

  /**
   * Starts the client and returns the normalized session. Order: refuse a policy that is short of
   * layers (`security.unenforced: refuse`), write the profile files, launch the process with the
   * environment the base built, hand it to the transport. If the transport fails, the whole
   * process tree is ended before the error goes up, so a failed open leaves nothing running.
   *
   * `process-per-session` clients get a process of their own. `multi-session` clients share one
   * process per profile and environment, up to `sessionsPerProcess` sessions, and another process
   * starts above that or when the caller passes `{ process: 'own' }`. A session that leaves does
   * not end a process others still use; the last one out ends the tree. The sessions of a shared
   * process all fail with `AdapterUnavailable` when it dies. [proposta]
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
   * process for several sessions (`processModel: 'multi-session'`).
   */
  async launchSpec(
    profile: Profile,
    policy: RolePolicy,
    cwd: string,
    via: TransportId = 'acp',
  ): Promise<LaunchOptions> {
    this.#assertGuaranteed(policy, via);
    return this.#spec(profile, policy, cwd);
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
  ): Promise<AgentSession> {
    return this.#attachOwned(process, policy, cwd, via, undefined);
  }

  /** Same as {@link openSessionOn} for an existing conversation (`session/load`). */
  loadSessionOn(
    process: LaunchedProcess,
    policy: RolePolicy,
    cwd: string,
    sessionId: string,
    via: SessionTransport,
  ): Promise<AgentSession> {
    if (!this.capabilities.loadSession) {
      return Promise.reject(
        new AdapterUnavailable(
          `${this.id} cannot reload a conversation (capabilities.loadSession is false)`,
        ),
      );
    }
    return this.#attachOwned(process, policy, cwd, via, sessionId);
  }

  /**
   * Layer 2 of the permissions (architecture 5.8): the answer to a `session/request_permission`,
   * the same for every client. With `onAsk: 'reject'` it picks `reject_once`, which refuses this
   * request and leaves no rule behind in the client (`reject_always` may be written to the profile
   * and would outlive the policy that asked for it); `reject_always` only when `reject_once` is not
   * offered; and `cancelled` when no option refuses. It never selects an `allow_*` option. [proposta]
   */
  protected answerPermission(request: PermissionRequest, policy: RolePolicy): PermissionAnswer {
    // `onAsk` has a single value in version 1. Any other value reaching here is a bug or a newer
    // policy: the safe answer is still to refuse.
    const onAsk: string = policy.onAsk;
    if (onAsk !== 'reject') return { outcome: 'cancelled' };
    for (const kind of ['reject_once', 'reject_always'] as const) {
      const option = request.options.find((candidate) => candidate.kind === kind);
      if (option !== undefined) return { outcome: 'selected', optionId: option.optionId };
    }
    return { outcome: 'cancelled' };
  }

  /**
   * Joins what the client guarantees by itself (`enforcement()`) with what layer 3 offers on this
   * machine, per field, and points at the fields with fewer layers than `security.min_layers`
   * (architecture 5.2, "Garantia por campo"). Pure and synchronous. The `daemon` layer counts only
   * for `onAsk` and `bypass`: refusing a request does not stop a tool that never asks.
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
   * `mapConfig` is protected, so the caller gets it through here.
   */
  configOptionsFor(want: ExecutorConfig): Record<string, string> {
    return this.mapConfig(want);
  }

  // ---- specific, each client fills in ----

  /** Executable and arguments of the ACP client, e.g. `npx claude-agent-acp`. */
  protected abstract command(profile: Profile): { cmd: string; args: string[] };
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
  /** Agent shell: quota (N42), login, stuck client. */
  protected abstract normalizeError(raw: unknown, via: TransportId): NormalizedError;
  /** Model, effort and mode in the ids of the client. */
  protected abstract mapConfig(want: ExecutorConfig): Record<string, string>;
  /** Answers the `_otheater/<resource>` extension methods of this client. */
  protected abstract extensions(): AcpExtensionHandler[];
  /** Probes of this client, in addition to the common ones. */
  protected abstract probes(): ConformanceProbe[];
  abstract login(profile: Profile): Promise<LoginFlow>;
  abstract logout(profile: Profile): Promise<void>;

  // ---- internals ----

  async #start(
    profile: Profile,
    policy: RolePolicy,
    cwd: string,
    via: SessionTransport,
    sessionId: string | undefined,
    options: SessionStartOptions | undefined,
  ): Promise<AgentSession> {
    this.#assertGuaranteed(policy, via.id);
    const mcpServers = this.#mcpServersOf(policy);
    // The spec is built on every open, shared process or not: the profile files and the slot the
    // descendant keeps for this policy are written per session, and the key needs the environment.
    const spec = await this.#spec(profile, policy, cwd);
    const sharing =
      this.processModel === 'multi-session' &&
      (options?.process ?? this.#processReuse) === 'shared';
    const process = sharing
      ? await this.#shared.acquire(sharedProcessKey(profile, spec), spec)
      : await this.#launcher.launch(spec);
    try {
      return await this.#attach(process, policy, cwd, via, sessionId, mcpServers);
    } catch (error) {
      await this.#reap(process);
      throw isOTheaterError(error) ? error : this.#unavailable(error);
    }
  }

  async #spec(profile: Profile, policy: RolePolicy, cwd: string): Promise<LaunchOptions> {
    await this.prepareProfile(profile, policy);
    const { cmd, args } = this.command(profile);
    return { cmd, args, cwd, env: { ...this.#baseEnv, ...this.profileEnv(profile) } };
  }

  async #attach(
    process: LaunchedProcess,
    policy: RolePolicy,
    cwd: string,
    via: SessionTransport,
    sessionId: string | undefined,
    mcpServers: readonly McpServerRef[],
  ): Promise<AgentSession> {
    const params: SessionOpenParams = {
      process,
      cwd,
      setup: this.sessionSetup(policy, via.id),
      mcpServers,
      normalizer: this.#normalizer(via.id),
      onPermission: (request) => this.answerPermission(request, policy),
      extensions: this.extensions(),
    };
    return sessionId === undefined ? via.open(params) : via.load({ ...params, sessionId });
  }

  async #attachOwned(
    process: LaunchedProcess,
    policy: RolePolicy,
    cwd: string,
    via: SessionTransport,
    sessionId: string | undefined,
  ): Promise<AgentSession> {
    try {
      this.#assertGuaranteed(policy, via.id);
      const mcpServers = this.#mcpServersOf(policy);
      return await this.#attach(process, policy, cwd, via, sessionId, mcpServers);
    } catch (error) {
      throw isOTheaterError(error) ? error : this.#unavailable(error);
    }
  }

  #assertGuaranteed(policy: RolePolicy, via: TransportId): void {
    if (this.#unenforced === 'allow') return;
    const report = this.guarantee(policy, this.#sandbox, via);
    if (report.ok) return;
    if (this.#unenforced === 'warn') {
      this.#warn({ kind: 'unenforced', clientId: this.id, short: report.short });
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

  #mcpServersOf(policy: RolePolicy): readonly McpServerRef[] {
    if (policy.mcpServers.length === 0) return [];
    if (this.#resolveMcpServers === undefined) {
      throw new InvalidInput(
        `${this.id}: the role names MCP servers (${policy.mcpServers.join(', ')}) and no resolver was given`,
      );
    }
    return this.#resolveMcpServers(policy.mcpServers);
  }

  #normalizer(via: TransportId): SessionNormalizer {
    return {
      normalizeUpdate: (raw) => this.normalizeUpdate(raw, via),
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
