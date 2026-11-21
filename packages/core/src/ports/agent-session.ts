// SPDX-License-Identifier: MPL-2.0
import type { Disposable } from '../disposable.js';
import type {
  ConfigValue,
  ContentBlock,
  NormalizedUpdate,
  StopReason,
} from '../normalized-update.js';
import type { LaunchedProcess } from './process-launcher.js';

/** Semver of the `AgentSession` port contract (architecture 5.18, "Versão dos contratos"). */
export const AGENT_SESSION_PORT_VERSION = '0.1.0';

/** How a prompt turn ended. [proposta] Only the normalized stop reason for now. */
export interface PromptOutcome {
  readonly stopReason: StopReason;
}

export type UpdateListener = (update: NormalizedUpdate) => void;

/** One value of a select config option (ACP `SessionConfigSelectOption`). */
export interface SessionConfigChoice {
  /** The id `setConfig` takes. */
  readonly value: string;
  readonly name?: string;
  readonly description?: string;
}

/** A named group of values of a select config option (ACP `SessionConfigSelectGroup`). */
export interface SessionConfigChoiceGroup {
  readonly group: string;
  readonly name?: string;
  readonly options: readonly SessionConfigChoice[];
}

/**
 * A session config option as the client announced it (ACP `SessionConfigOption`), in neutral
 * terms: core does not know ACP. [proposta] Only what the daemon reads: the model and effort
 * catalogs find their lists here. A `select` option lists its `options` flat or grouped; a
 * `boolean` has none.
 */
export interface SessionConfigOption {
  readonly id: string;
  readonly name?: string;
  /** `model`, `thought_level`, `mode`, `model_config` or a custom (`_`-prefixed) category. */
  readonly category?: string;
  readonly type: 'select' | 'boolean';
  readonly currentValue?: ConfigValue;
  readonly options?: readonly (SessionConfigChoice | SessionConfigChoiceGroup)[];
}

/**
 * One `/` command a client announced for the session (ACP `available_commands_update`), in
 * neutral terms. Phase 7, P3: the daemon lists them for the Director session, with the client's
 * prefix, and runs one only outside a turn.
 */
export interface SessionCommand {
  readonly name: string;
  readonly description: string;
  readonly inputHint?: string | undefined;
}

/**
 * The normalized conversation with an Executor (architecture 5.2, "Casca de agente"; 5.18): the
 * only thing the Director, the pipeline and the interfaces see of a client. Whatever the
 * transport (ACP, headless, SDK), it looks like this. The `ClientAdapter` hands it out.
 *
 * Contract (the conformance suite comes with the transport step):
 * - `prompt` resolves when the turn ends, with a normalized `stopReason`. Updates of the turn reach
 *   the listeners before it resolves. A second `prompt` while one runs rejects with `Conflict`.
 * - `prompt` rejects with the typed error of the cause: `QuotaExhausted`, `PermissionDenied`,
 *   `Transient`, `AdapterUnavailable` (the client process died). A cancelled turn resolves with
 *   `stopReason: 'cancelled'`, it does not reject.
 * - `onUpdate` returns a handle; a listener that throws does not break the session.
 * - `cancel` is idempotent. It asks the client to stop and ends the process tree of the client
 *   (architecture 5.2: do not trust ACP's cancel alone), then resolves.
 * - `setConfig` changes a session config option (`model`, `thought_level`, `mode`...); an id or
 *   value the client does not offer rejects with `InvalidInput`. When it resolves, `configOptions`
 *   already shows the new value (for a client that reports its options).
 * - `configOptions` is the snapshot of the options the client announced for the session, taken at
 *   `session/new` or `session/load`, replaced whenever the client sends the full list again (the
 *   answer of `setConfig`, a `config_option_update`). [proposta] It is empty for a client that
 *   announces none; it stays readable after the session ends.
 * - `close` ends the session and releases the process when it was the last session on it; after
 *   it every method rejects with `AdapterUnavailable`.
 */
export interface AgentSession {
  /** Id of the conversation as the client knows it (the ACP `sessionId`); what `loadSession` takes. */
  readonly sessionId: string;
  /** This session can be reloaded later with `loadSession` (native resume, architecture 5.16). */
  readonly canLoad: boolean;
  /** Snapshot of the config options the client announced; see the contract above. */
  readonly configOptions: readonly SessionConfigOption[];
  /**
   * [proposta] The `/` commands the client announced, the last list it sent (Phase 7, P3); absent
   * on a session that does not keep them, empty when the client announced none.
   */
  readonly availableCommands?: readonly SessionCommand[];
  prompt(blocks: readonly ContentBlock[]): Promise<PromptOutcome>;
  onUpdate(listener: UpdateListener): Disposable;
  cancel(): Promise<void>;
  setConfig(id: string, value: ConfigValue): Promise<void>;
  close(): Promise<void>;
}

/** Raw message of the client, before the shell normalizes it (an ACP `session/update`, a stream-json line). */
export type RawUpdate = unknown;

/** The kinds of failure the shell tells apart (architecture 5.2, 5.16). [proposta] */
export const NORMALIZED_ERROR_KINDS = [
  'quota_exhausted',
  'auth_required',
  'transient',
  'client_crash',
  'stuck',
  'refusal',
  'permission',
  'unknown',
] as const;

/**
 * Where a limit error came from (P8, architecture 5.6). [proposta] The names:
 * - `rate_limit_event`: a rate-limit event of the client's stream (it travels as a `rate_limit`
 *   update, not as an error; listed so the quota service has one vocabulary);
 * - `429`: the client reported an HTTP 429 of the provider;
 * - `message`: the client's own message said the limit was reached (matched by pattern);
 * - `structured`: a typed field said so (the `-32001` code, `data.type`, `codexErrorInfo`).
 */
export const LIMIT_SOURCES = ['rate_limit_event', '429', 'message', 'structured'] as const;

export type LimitSource = (typeof LIMIT_SOURCES)[number];

/** An error of the client in the OTheater's own terms (what `normalizeError` returns). */
export interface NormalizedError {
  readonly kind: (typeof NORMALIZED_ERROR_KINDS)[number];
  readonly message: string;
  /** When the quota comes back, epoch ms, if some source says it (N42). */
  readonly resetsAt?: number;
  /** Only for `quota_exhausted`: what told the shell about the limit. */
  readonly limitSource?: LimitSource;
  /** The original error, for the log. */
  readonly cause?: unknown;
}

/** What the descendant of the `ClientAdapter` hands to a transport to translate the client's messages. */
export interface SessionNormalizer {
  /** `null`: nothing to tell the daemon (a message the shell swallows). */
  normalizeUpdate(raw: RawUpdate): NormalizedUpdate | null;
  /**
   * [proposta] More updates the same raw message carries (the other windows of a Claude
   * `rate_limit_event`), handed to the listeners after the main one, in order. Absent: none.
   */
  normalizeExtraUpdates?(raw: RawUpdate): readonly NormalizedUpdate[];
  normalizeError(raw: unknown): NormalizedError;
}

/** An option of a permission request (ACP `PermissionOption`). */
export interface PermissionOption {
  readonly optionId: string;
  readonly name: string;
  readonly kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
}

/** A `session/request_permission`, reduced to what the policy needs (architecture 5.8, layer 2). */
export interface PermissionRequest {
  readonly toolCallId?: string;
  readonly title?: string;
  readonly toolKind?: string;
  /**
   * What the rules of layer 2 read (Phase 4, P2), each present only when the client said it, so a
   * transport that does not fill them leaves the request as it was. [proposta]
   * - `toolName`: the tool as the client names it (`_meta.claudeCode.toolName` for Claude Code [N]);
   * - `locations`: the files the call touches (`toolCall.locations`, or the path of `rawInput`);
   * - `command`: the command line of a call that runs one (`rawInput.command`);
   * - `url`: the address of a call that fetches one (`rawInput.url`).
   */
  readonly toolName?: string;
  readonly locations?: readonly string[];
  readonly command?: string;
  readonly url?: string;
  /**
   * The MCP tool the call is, when the client says so: the server and the tool as `rawInput` of the
   * tool call names them (`{ server, tool }`), not as the client prefixes them in a title. Present
   * only when the call is marked as an MCP call (`is_mcp_tool_approval` on the request or
   * `is_mcp_tool_call` on the tool call) AND both names are non-empty strings. [V] Codex
   * (codex-acp 2.6.0, 2026-11-17): the request itself carries only `toolCallId`, `kind: execute` and
   * `status`; the names come from the earlier `tool_call` of the same id, which the transport
   * merges in. [proposta] the name of this field.
   */
  readonly mcpTool?: { readonly server: string; readonly tool: string };
  readonly options: readonly PermissionOption[];
}

export type PermissionAnswer =
  { readonly outcome: 'selected'; readonly optionId: string } | { readonly outcome: 'cancelled' };

/**
 * MCP server handed to the session (architecture 5.2, `session/new`): HTTP at `url`, with the
 * `headers` to send. `stdio`, when present, is a second way to the same server: a process the
 * client starts and talks to over its standard streams (N161, the shim of the framework server on
 * macOS, where Seatbelt refuses a confined client the loopback of the host). A transport that can
 * start an MCP process uses `stdio` and ignores `url`; one that cannot uses `url`.
 */
export interface McpServerRef {
  readonly name: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly stdio?: McpStdioLaunch;
}

/** How a client starts an MCP server that speaks over stdio (ACP `McpServerStdio`). */
export interface McpStdioLaunch {
  /** Absolute path of the executable. */
  readonly command: string;
  readonly args: readonly string[];
  /** Added to the environment the client gives the process; the secrets of the server go here. */
  readonly env: Readonly<Record<string, string>>;
}

/**
 * What the client needs per session, in the form of the transport that will carry it
 * (architecture 5.2, `SessionSetup`).
 */
export type SessionSetup =
  | {
      readonly via: 'acp';
      /** Content of `_meta` in `session/new` (for Claude, `claudeCode.options`). */
      readonly meta?: unknown;
      /** Config option id to value, applied with `session/set_config_option`. */
      readonly configOptions: Readonly<Record<string, string>>;
      /**
       * Additive (Phase 8, P3): the title the transport sets with `session/set_title` right after
       * `session/new`/`session/load`, before the first prompt. Codex (`codex-acp`) opens one more
       * model thread to write a title when the session has none; with a title it does not.
       */
      readonly title?: string;
    }
  | {
      readonly via: 'headless';
      readonly args: readonly string[];
      readonly env: Readonly<Record<string, string>>;
    };

/**
 * A handler of an ACP extension method `_otheater/<resource>` that the shell exposes to the client
 * (architecture 5.2, "Recursos únicos também viram ACP"). Structurally the same as the
 * `AcpExtensionHandler` of the `ClientAdapter` base, so what `extensions()` returns goes straight
 * into {@link SessionOpenParams.extensions}. [proposta] Defined here because the port is where the
 * transport reads it.
 */
export interface SessionExtensionHandler {
  /** Method name, `_otheater/<resource>` or `_otheater/<client>/<resource>`. */
  readonly method: string;
  /** Answers the request; may return a promise. */
  handle(params: unknown): unknown;
}

/**
 * What the client says about itself in the ACP `initialize` (`agentInfo`: name and version).
 * For Claude Code and Codex it names the ACP adapter the daemon starts, not the client
 * behind it (Phase 0: `claude-agent-acp` 0.107.0 and `@agentclientprotocol/codex-acp` 2.6.0 [V]);
 * for OpenCode it is the client itself (1.19.5 [V]).
 */
export interface AgentInfo {
  readonly name: string;
  readonly title?: string;
  readonly version: string;
}

/** What a transport receives to open or load a session. */
export interface SessionOpenParams {
  /**
   * The client process, already started by the launcher; the transport speaks to its streams.
   *
   * [proposta] Several sessions on one process (`processModel: 'multi-session'`): the caller hands
   * every session of that process the SAME stream objects (`stdin`, `stdout`), usually through a
   * view of the process whose `killTree` only detaches the session (see `SharedProcessRegistry`).
   * A transport that can serve several sessions on one connection recognises the process by its
   * streams, shares the connection and routes by `sessionId`. A transport that cannot rejects the
   * second `open` on a process it already serves; the one-session-per-process path is unchanged.
   */
  readonly process: LaunchedProcess;
  /** Absolute path of the worktree. */
  readonly cwd: string;
  readonly setup: SessionSetup;
  readonly mcpServers: readonly McpServerRef[];
  readonly normalizer: SessionNormalizer;
  /** Layer 2 of the permissions (architecture 5.8): answers every `session/request_permission`. */
  readonly onPermission: (request: PermissionRequest) => PermissionAnswer;
  /**
   * Additive: the `_otheater/*` extension methods this session answers (`extensions()` of the
   * client adapter). A request of the client for such a method carries the `sessionId` it comes
   * from and goes to the handlers of that session only; with several sessions on one connection
   * each one keeps its own handlers. Absent means none: every extension request is refused with
   * `method not found`.
   */
  readonly extensions?: readonly SessionExtensionHandler[];
  /**
   * Additive and optional (N63): a transport that learns who the client is during the handshake
   * (the `agentInfo` of the ACP `initialize`) calls this with it, once for every session it opens
   * or loads, before the session is handed back. It is not called when the client says nothing.
   * The `ClientAdapter` base uses it to confirm or correct the client version it read from the
   * `package.json` (architecture 5.2, "Versão do cliente"). A transport with no handshake (the
   * headless one) never calls it; the callback must not throw.
   */
  readonly onAgentInfo?: (info: AgentInfo) => void;
}

export interface SessionLoadParams extends SessionOpenParams {
  /** `AgentSession.sessionId` of the conversation to reload. */
  readonly sessionId: string;
}

/**
 * The way a session talks to the client below the shell: ACP, the client's headless mode, or an SDK
 * (architecture 5.2, "Saída de emergência"). A separate object used by composition, so the
 * transport can change without a new `ClientAdapter`. The concrete `AcpTransport` comes in Phase 2.
 *
 * `open` and `load` reject with `AdapterUnavailable` when the client does not answer, and `load`
 * also when the transport or the client cannot load (`canLoad` is false).
 */
export interface SessionTransport {
  /** `'acp'`, `'headless'` or the id of another transport. */
  readonly id: 'acp' | 'headless' | (string & {});
  open(params: SessionOpenParams): Promise<AgentSession>;
  load(params: SessionLoadParams): Promise<AgentSession>;
}
