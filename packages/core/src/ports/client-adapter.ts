// SPDX-License-Identifier: MPL-2.0
import type { Adapter } from './adapter.js';
import type { AgentSession, McpServerRef, SessionTransport } from './agent-session.js';
import type { ConfigCategory } from '../normalized-update.js';
import type { Profile } from './executor.js';
import type { ModelCatalog } from './model-catalog.js';
import type { QuotaProbe } from './quota-probe.js';

/**
 * Semver of the `ClientAdapter` port contract (architecture 5.18, "Versão dos contratos").
 * `0.2.0` (N68): `openSession` and `loadSession` take `options?: SessionStartOptions`. The
 * parameter is optional, but a client adapter that ignores `purpose: 'catalog-probe'` would hand a
 * working session to a caller that expects one that cannot run a prompt, so the range
 * `^0.1.0` no longer vouches for it. [proposta]
 * `0.3.0` (Phase 4, P1): `RolePolicy` is version 2 (`nativeShell: 'shells'`, `onAsk: 'rules'`,
 * `mcpTools`). A client adapter written for version 1 would read `shells` as no shell and an MCP
 * server as whole, so the range `^0.2.0` no longer vouches for it. [proposta]
 */
export const CLIENT_ADAPTER_PORT_VERSION = '0.3.0';

/**
 * The tools of one MCP server that a role may call: the names, or `all` for a server whose tools
 * the daemon does not know in advance (a plugin server). [proposta]
 */
export type McpToolSet = readonly string[] | 'all';

/**
 * Neutral policy of a role: it names no key of any client (architecture 5.2). The descendant of
 * the `ClientAdapter` translates it. Version 2 (Phase 4, P1, [proposta]); the daemon builds it
 * from the configuration (`roles.<role>.policy`) and refuses an opening that is always forbidden
 * (N99), so `bypass`, the native shell of the client and `writeScope` keep a single value here.
 */
export interface RolePolicy {
  /** Native tools that exist; the others are removed. */
  readonly nativeTools: readonly ('read' | 'search' | 'edit' | 'write')[];
  /**
   * `none`: the role has no shell at all. `shells`: the role also gets the shells of the daemon
   * (5.8, `restricted_shell`, `run_tests`...), which reach the client as MCP tools listed in
   * {@link RolePolicy.mcpTools}. The shell of the client itself is never available, in either value.
   */
  readonly nativeShell: 'none' | 'shells';
  /** Only the MCP servers of the role (strict). */
  readonly mcpServers: readonly string[];
  /**
   * The tools the role may call, per server of {@link RolePolicy.mcpServers}, by the name the
   * server announces (without the client's prefix). A server with no entry has no tool allowed
   * (fail closed); a tool of the server that is not listed stays under the layer 2 answer.
   */
  readonly mcpTools: Readonly<Record<string, McpToolSet>>;
  /**
   * `reject`: reject every request. `rules`: answer by the release rules of the daemon (layer 2,
   * P2); the request outside the policy is still rejected.
   */
  readonly onAsk: 'reject' | 'rules';
  readonly bypass: 'forbidden';
  readonly writeScope: 'worktree';
  /** Allowed domains; guaranteed by layer 3. */
  readonly network: { readonly allow: readonly string[] };
}

/** The tools of `server` the policy allows; none for a server the policy gives no entry. */
export function mcpToolsOf(policy: RolePolicy, server: string): McpToolSet {
  return Object.hasOwn(policy.mcpTools, server) ? (policy.mcpTools[server] ?? []) : [];
}

/** Fields of the {@link RolePolicy}, the keys of {@link Enforcement}. */
export const ROLE_POLICY_FIELDS = [
  'nativeTools',
  'nativeShell',
  'mcpServers',
  'mcpTools',
  'onAsk',
  'bypass',
  'writeScope',
  'network',
] as const satisfies readonly (keyof RolePolicy)[];

export type RolePolicyField = (typeof ROLE_POLICY_FIELDS)[number];

/** Who guarantees a field: the client alone, the daemon (layer 2 or a veto) or the operating system (layer 3). */
export type Guarantee = 'client' | 'daemon' | 'os';

/** Layers per field; an empty list means no guarantee (architecture 5.2, "Garantia por campo"). */
export type Enforcement = Readonly<Record<RolePolicyField, readonly Guarantee[]>>;

/** What layer 3 offers on this machine: the fields the `Sandbox` can guarantee. [proposta] */
export interface SandboxCapabilities {
  readonly fields: readonly RolePolicyField[];
}

/** One field of a {@link GuaranteeReport}. */
export interface FieldGuarantee {
  readonly layers: readonly Guarantee[];
  /** Layers required by `security.min_layers` for this field. */
  readonly required: number;
  readonly ok: boolean;
}

/** Result of `guarantee()`: per field, and the fields short of the required layers. */
export interface GuaranteeReport {
  readonly fields: Readonly<Record<RolePolicyField, FieldGuarantee>>;
  readonly ok: boolean;
  readonly short: readonly RolePolicyField[];
}

/** One conformance probe that ran (architecture 5.2, "Sondas de conformidade"). */
export interface ProbeResult {
  readonly id: string;
  readonly ok: boolean;
  readonly detail?: string;
}

export interface ConformanceReport {
  /** Version of the client adapter the probes ran against (the cache key). */
  readonly adapterVersion: string;
  readonly ok: boolean;
  readonly probes: readonly ProbeResult[];
}

/** Process model of the client adapter, measured in Phase 0 (architecture 5.2, "Pools"). */
export type ProcessModel = 'process-per-session' | 'multi-session';

/**
 * The kinds of input beyond text a client can take in a prompt (architecture 5.20: "o
 * `ClientAdapter` declara os tipos de entrada que aceita"). Text is always accepted.
 * [proposta] The list; `image` is the only one P12 acts on.
 */
export const INPUT_TYPES = ['image', 'audio', 'pdf'] as const;
export type InputType = (typeof INPUT_TYPES)[number];

/** What only this client offers, announced at `initialize` (architecture 5.2). */
export interface ClientCapabilities {
  /** The client can reload a conversation (`session/load`). */
  readonly loadSession: boolean;
  /** MCP servers over HTTP are accepted. */
  readonly mcpHttp: boolean;
  /** Config option categories the client accepts (`model`, `thought_level`, `mode`, `model_config`). */
  readonly configOptions: readonly ConfigCategory[];
  /** The client has a headless mode usable as the emergency exit. */
  readonly headless: boolean;
  /** Names of the `_otheater/<resource>` extension methods the shell exposes. */
  readonly extensions: readonly string[];
  /**
   * Input types besides text the client accepts (an image attachment, say). [proposta] Absent
   * means text only: an adapter that cannot verify the answer leaves it out, so no demand with an
   * image ever reaches it. The real adapters do not declare it yet.
   */
  readonly inputTypes?: readonly InputType[];
}

export const LOGIN_MODES = ['browser', 'device_code', 'terminal'] as const;

/**
 * An official login in progress in the profile directory (architecture 5.2, 5.6). The login runs
 * in the client's own tool; the daemon never reads the token. [proposta] shape.
 */
export interface LoginFlow {
  readonly mode: (typeof LOGIN_MODES)[number];
  /** URL the Producer opens, when the mode has one. */
  readonly url?: string;
  /** Code the Producer types there (`device_code`). */
  readonly code?: string;
  /** Resolves when the login finished; rejects with `Cancelled` or `PermissionDenied`. */
  complete(): Promise<void>;
  cancel(): Promise<void>;
}

/** `multi-session` reuse: `shared` puts sessions of one profile on one process, `own` gives each its own. */
export type ProcessReuse = 'shared' | 'own';

/** What a session is for; see {@link SessionStartOptions.purpose}. */
export type SessionPurpose = 'work' | 'catalog-probe';

/**
 * What a caller can ask of one `openSession`/`loadSession` (N68). A call without it behaves as a
 * `work` session on the adapter's default process reuse. [proposta]
 */
export interface SessionStartOptions {
  /**
   * `own` starts a process for this session alone, even when the client is `multi-session` and a
   * shared one has room. `shared` joins one. Ignored for a `process-per-session` client, which
   * always gets its own. Default: what the adapter is configured for.
   */
  readonly process?: ProcessReuse;
  /**
   * What the session is for. `work` (default): a session that runs prompts. `catalog-probe`: a
   * session opened only to read the config options the client announces (model, effort, mode).
   *
   * Contract: an adapter that receives `catalog-probe` returns a session whose `prompt` and
   * `setConfig` reject with `PermissionDenied` without sending anything to the client (the
   * `CatalogProbeSession` of `@otheater/core` does it for any `AgentSession`). Only then may the
   * adapter exempt the session from the guarantee-layer check (`security.unenforced`), and only
   * when its configuration allows it (`security.catalog_probe`); a session that can run nothing
   * needs no guarantee that the policy holds while it runs.
   */
  readonly purpose?: SessionPurpose;
  /**
   * MCP servers of this session alone, with the address and headers only the caller knows (the
   * daemon's framework server, with the token of the attempt: architecture 5.3). Each name must
   * be one of `policy.mcpServers`; the policy stays the strict list of what the role may use, and
   * a ref outside it is refused with `InvalidInput`. A name here is not resolved by the adapter's
   * `resolveMcpServers`. [proposta] Additive, without a new port version: a session that ignored it
   * would only run without the framework tools, and every descendant of `ClientAdapterBase` honours it.
   */
  readonly mcpServers?: readonly McpServerRef[];
}

/**
 * Public face of a client adapter (architecture 5.2). The abstract class `ClientAdapter`, with the
 * common methods written once (`openSession`, `answerPermission`, `guarantee`, `checkConformance`)
 * and the abstract ones each client fills in (`command`, `profileEnv`, `sessionSetup`,
 * `enforcement`, `normalizeUpdate`, `normalizeError`, `mapConfig`...), arrives in the transport
 * step of Phase 2 and implements this interface. Here only what the rest of the daemon sees.
 *
 * Contract:
 * - `openSession` starts the client through the `ProcessLauncher`, applies the setup and returns
 *   the normalized session. It rejects with `AdapterUnavailable` (client missing, process died),
 *   `PermissionDenied` (`security.unenforced: refuse` for a field short of layers) or
 *   `QuotaExhausted`.
 * - `loadSession` is `openSession` for an existing conversation; it rejects with `AdapterUnavailable`
 *   when `capabilities.loadSession` is false, and with `NotFound` when the client no longer has it.
 * - `guarantee` is pure and synchronous.
 */
export interface ClientAdapterContract extends Adapter {
  /** `'claude-code'`, `'codex'`, `'opencode'`, `'gemini'` or another client id. */
  readonly id: string;
  readonly processModel: ProcessModel;
  readonly quota: QuotaProbe;
  readonly models: ModelCatalog;
  readonly capabilities: ClientCapabilities;
  openSession(
    profile: Profile,
    policy: RolePolicy,
    cwd: string,
    via: SessionTransport,
    options?: SessionStartOptions,
  ): Promise<AgentSession>;
  loadSession(
    profile: Profile,
    policy: RolePolicy,
    cwd: string,
    sessionId: string,
    via: SessionTransport,
    options?: SessionStartOptions,
  ): Promise<AgentSession>;
  guarantee(policy: RolePolicy, os: SandboxCapabilities): GuaranteeReport;
  checkConformance(profile: Profile): Promise<ConformanceReport>;
  login(profile: Profile): Promise<LoginFlow>;
  logout(profile: Profile): Promise<void>;
}
