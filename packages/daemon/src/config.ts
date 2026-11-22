// SPDX-License-Identifier: MPL-2.0
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import {
  COMMON_NAME,
  DEFAULT_DIRECTIVE_TIMEZONE,
  DEFAULT_ROTATE_ON_EXHAUSTION,
  DEFAULT_SUMMARY_MESSAGES,
  DEFAULT_SHELL_ALLOWLIST,
  DELIVERY_MODES,
  InvalidInput,
  isKnownTimezone,
  parseAllowEntry,
  ProjectCommandSchema,
  PROMPT_ORDER_MODES,
  ROLE_IDS,
  ROTATE_ON_EXHAUSTION_MODES,
  SecretKeySchema,
  SHARED_CANCEL_MODES,
  TRUNCATE_MODES,
} from '@otheater/core';
import { DEFAULT_UI_REGISTRY, resolveKeymap } from '@otheater/client';
import {
  BACKUP_CONTENTS,
  LAYOUT_STORES,
  LAYOUT_SYNCS,
  TERMINAL_OUTPUT_MODES,
  UiClipboardConfigSchema,
  UiChatConfigSchema,
  UiInputConfigSchema,
  UiKeymapConfigSchema,
  UiMouseModeSchema,
  UiOverviewConfigSchema,
  UiRenderConfigSchema,
  UiRuntimeConfigSchema,
  UiNewProjectConfigSchema,
  UiSetupConfigSchema,
  UiSidebarConfigSchema,
  UiTuiLayoutConfigSchema,
  UiTrajectoriesConfigSchema,
  UiUsageConfigSchema,
  UiTuiMouseConfigSchema,
} from '@otheater/protocol';
import { parse as parseYaml, YAMLParseError } from 'yaml';
import { z } from 'zod';
import {
  ADMISSION_MODES,
  DEFAULT_ADMISSION,
  DEFAULT_SESSION_MB,
  FALLBACK_SESSION_MB,
  UNKNOWN_RAM_MODES,
} from './execution/admission.js';
import { BUDGET_ON_CAP_CHANGE_MODES, BUDGET_UNKNOWN_COST_MODES } from './budget-config.js';
import {
  DIRECT_CONFIRM_MODES,
  DIRECT_IDLE_TIMEOUT_DEFAULT,
  DIRECT_ON_CLOSE_MODES,
  DIRECT_ORPHANS_MODES,
  DIRECT_WORKSPACES,
} from './direct/direct-config.js';
import { AnalysisConfigSchema } from './analysis/analysis-config.js';
import { AtifConfigSchema } from './atif/atif-config.js';
import {
  exportsOtlp,
  HEADER_NAME_PATTERN,
  SUPPORTED_OTLP_PROTOCOLS,
  TELEMETRY_EXPORT_FAILURE_MODES,
  TELEMETRY_EXPORT_MODES,
  TELEMETRY_OTLP_COMPRESSIONS,
  TELEMETRY_OTLP_PROTOCOLS,
  TELEMETRY_RETRY_BACKOFFS,
} from './telemetry/export-config.js';
import {
  LOG_ROTATE_MODES,
  TELEMETRY_RETENTION_GUARDS,
  TELEMETRY_RETENTION_MODES,
} from './telemetry/retention-config.js';
import { IdeasConfigSchema } from './ideas/settings.js';
import { withProfileEntries } from './profile-entries-config.js';
import {
  ExecutorsConfigSchema,
  ModelsConfigSchema,
  SelectionConfigSchema,
} from './role-executors-config.js';
import { RolesConfigSchema } from './role-policy-config.js';
import {
  APP_TERMINAL_MODES,
  SHELL_COMMAND_MODES,
  SHELL_CONTEXT_MODES,
  SHELL_TIMEOUT_DEFAULT,
  SNIPPET_KEEP_MODES,
} from './shell-config.js';

/** `setup.role_lists`: what the setup assistant writes of the lists of the roles. */
export const SETUP_ROLE_LIST_MODES = ['explicit', 'preset'] as const;
export type SetupRoleListMode = (typeof SETUP_ROLE_LIST_MODES)[number];

/** How long a number of time units lasts, for `30m`, `2h`... */
const UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

const DURATION_PATTERN = /^(\d+)(ms|s|m|h|d)$/;

/** `"30m"` to milliseconds. Returns `undefined` when the text is not `<integer><ms|s|m|h|d>`. */
export function parseDuration(text: string): number | undefined {
  const match = DURATION_PATTERN.exec(text.trim());
  if (match === null) return undefined;
  const unit = match[2] as keyof typeof UNIT_MS;
  return Number(match[1]) * UNIT_MS[unit];
}

/** A duration written as text (`30m`, `2h`, `45s`, `1d`, `500ms`); the parsed value is milliseconds. */
export const DurationSchema = z.string().transform((text, ctx) => {
  const ms = parseDuration(text);
  if (ms === undefined || ms <= 0) {
    ctx.addIssue({ code: 'custom', message: 'expected a duration such as 30m, 2h, 45s or 1d' });
    return z.NEVER;
  }
  return ms;
});

const SIZE_PATTERN = /^(\d+)\s*(B|KB|MB|GB)$/i;
const SIZE_UNIT_BYTES = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 } as const;

/** `"50MB"` to bytes (binary multiples), or `undefined` when the text is not `<integer><B|KB|MB|GB>`. */
export function parseSize(text: string): number | undefined {
  const [, amount, unit] = SIZE_PATTERN.exec(text.trim()) ?? [];
  if (amount === undefined || unit === undefined) return undefined;
  return Number(amount) * SIZE_UNIT_BYTES[unit.toLowerCase() as keyof typeof SIZE_UNIT_BYTES];
}

/** A size written as text (`50MB`, `512KB`, `1GB`); the parsed value is bytes. Zero is allowed. */
export const SizeSchema = z.string().transform((text, ctx) => {
  const bytes = parseSize(text);
  if (bytes === undefined) {
    ctx.addIssue({ code: 'custom', message: 'expected a size such as 512KB, 50MB or 1GB' });
    return z.NEVER;
  }
  return bytes;
});

const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** `"03:00"` as hour and minute, or `undefined` when it is not `HH:MM` (24 hours). */
export function parseTimeOfDay(text: string): { hour: number; minute: number } | undefined {
  const match = TIME_OF_DAY_PATTERN.exec(text);
  if (match === null) return undefined;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/** A local time of day, `HH:MM`. YAML 1.2 keeps `"03:00"` a string, so no sexagesimal surprise. */
export const TimeOfDaySchema = z
  .string()
  .refine(
    (text) => parseTimeOfDay(text) !== undefined,
    'expected a time of day as HH:MM (24 hours)',
  );

export const BACKUP_WHEN = ['daily_after', 'on_idle', 'manual'] as const;
export const BACKUP_RETENTION = ['days', 'copies'] as const;
export const BACKUP_METHOD_NAMES = ['online_api', 'vacuum_into'] as const;
export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;
export const LOG_DESTINATIONS = ['file', 'stderr', 'both'] as const;
export const LOCALE_SETTINGS = ['auto', 'en', 'pt-BR'] as const;
export const STORE_ADAPTER_IDS = ['sqlite'] as const;
export const VAULT_ADAPTER_IDS = ['keyring', 'encrypted-file'] as const;
export const CLOCK_ADAPTER_IDS = ['system'] as const;
export const PROMPT_ADAPTER_IDS = ['files'] as const;
export const OPENCODE_PROCESS_MODELS = ['per_profile', 'per_session'] as const;
export const RESUME_PRESET_NAMES = ['balanced', 'patient', 'agile'] as const;

/**
 * `resume.package.summarize` (N126, decided 2026-11-18): who writes the long summary of the
 * continuation package. `deterministic` (default) builds it from the events and spends no quota;
 * `director_model` also asks the cheap model of the Director through a port, and the deterministic
 * summary stays in the package as the source of truth.
 */
export const PACKAGE_SUMMARIZE_MODES = ['deterministic', 'director_model'] as const;
/** [proposta] (P18) How much of the diff of the worktree the package carries. */
/**
 * [proposta] (P19) `resume.quota_wait_deadline`: whether the wait for a reset counts against the time
 * limit of the demand (`limits.demand_timeout`): `pause` stops the clock of the demand while the
 * attempt waits (the wait is not work); `count` lets the deadline run, so a long wait ends as a timeout.
 */
export const QUOTA_WAIT_DEADLINE_MODES = ['pause', 'count'] as const;
/**
 * [proposta] (P19) `resume.quota_wait_counts`: whether the native resume after a wait for the reset
 * counts in `resume.max_resumes`: `resume` counts it (a quota that comes and goes is bounded);
 * `free` does not (only a handoff or a stuck agent ends the loop). It never costs an attempt of the demand.
 */
export const QUOTA_WAIT_COUNTS_MODES = ['resume', 'free'] as const;
/**
 * [proposta] (P19) `resume.quota_wait_missed`: what follows a wait that ended with no word that the
 * profile came back (the reset did not come in time, `resume.quota_wait_grace` included): `handoff`
 * passes the baton, `park` leaves the attempt parked for a decision.
 */
export const QUOTA_WAIT_MISSED_MODES = ['handoff', 'park'] as const;
/**
 * [proposta] (P21b, N152) `resume.on_profile_removed`: what an attempt does when the profile of its
 * session is removed (cause `profile_removed`, architecture 5.16): `handoff` passes the baton to the
 * next Executor of the role (no attempt of the demand spent, outside `resume.max_resumes`); `park`
 * leaves the attempt `interrupted`, with `needsDecision`, for the Director to decide.
 */
export const ON_PROFILE_REMOVED_MODES = ['handoff', 'park'] as const;
export const PACKAGE_DIFF_MODES = ['full', 'stat', 'none'] as const;
/**
 * [proposta] (P18) What the handoff does in a role of short output (Reviewer, Screenwriter,
 * Critic): `redo` gives the work again to the new Executor with the partial notes; `continue`
 * treats it like any other role.
 */
export const PACKAGE_SHORT_OUTPUT_MODES = ['redo', 'continue'] as const;
/**
 * [proposta] `quota.probe.delivery`: how the `QuotaService` takes the readings of a probe. `both`
 * (default) watches the probes that can push and also polls `read` on a timer; `push` only
 * watches (a probe without `watch` is not used); `poll` only calls `read` on a timer.
 */
export const QUOTA_PROBE_DELIVERY_MODES = ['both', 'push', 'poll'] as const;
/**
 * `scenarios.director_failover` (P20, [proposta]): what the daemon does when the session of the
 * Director fails. `next` (default): a quota, a spending cap, a provider error or a drop opens a
 * new session with the next Executor; `quota_only`: only the first two causes; `off`: nothing.
 */
export const DIRECTOR_FAILOVER_MODES = ['next', 'quota_only', 'off'] as const;
export type DirectorFailoverMode = (typeof DIRECTOR_FAILOVER_MODES)[number];
/**
 * `scenarios.director_switch.in_turn` (P14, N242, [proposta]): what a manual switch of the Director
 * does when the Director is in the middle of a turn. `wait` (default): the switch waits for the
 * turn to end; `interrupt`: the turn is interrupted (as `/stop` does) and the switch happens now.
 */
export const DIRECTOR_SWITCH_IN_TURN_MODES = ['wait', 'interrupt'] as const;
export type DirectorSwitchInTurnMode = (typeof DIRECTOR_SWITCH_IN_TURN_MODES)[number];

/**
 * [proposta] `quota.minimax.mode` (P8): `off` (default) makes no call; `token_plan` reads the
 * remaining quota of the MiniMax Token Plan with the key of the profile (`GET /v1/token_plan/remains`).
 */
export const QUOTA_MINIMAX_MODES = ['off', 'token_plan'] as const;
/**
 * [proposta] `quota.minimax.usage_count_means`: what `current_*_usage_count` of the Token Plan
 * answer counts. Third-party notes [S] suggest what is LEFT (`remaining`, default); the real
 * meaning depends on the owner's key [N].
 */
export const QUOTA_MINIMAX_USAGE_COUNT_MEANS = ['remaining', 'used'] as const;
/**
 * `quota.opencode.mode` (P8; P25, N156). `auto` (default): a profile that declares
 * `profiles.<id>.codex_link` is read as `codex_link`, every other one as `ledger`. `codex_link`:
 * only the linked profiles have a reading, the 5h and 7d windows of the probe of Codex for the
 * Codex profile of the same ChatGPT account (the daemon reads no credential for it). `ledger`:
 * the usage of the sessions the daemon runs (the tokens of the answer of each prompt, or else the
 * growth of the context use) and their cost, compared with `limit_tokens` and `limit_usd`, for
 * every profile. [proposta] `off` keeps the probe without a reading, as before P8. In every mode
 * the 429 `subscription_sharing_*usage_limit_exceeded` is an exhausted quota.
 */
export const QUOTA_OPENCODE_MODES = ['auto', 'codex_link', 'ledger', 'off'] as const;
/**
 * [proposta] `usage.subscription_display` (architecture 5.6, P10): what the screens show for a
 * subscription profile. `quota_and_equivalent` (default) shows the quota and, beside it, the API
 * equivalent; `quota` shows only the quota; `prorated` divides the `monthly_price_usd` of the plan
 * by the use of the month.
 */
export const USAGE_SUBSCRIPTION_DISPLAY_MODES = [
  'quota_and_equivalent',
  'quota',
  'prorated',
] as const;
/**
 * [proposta] `usage.cost_source` (5.6, P10): where the cost of a turn comes from.
 * `client_then_pricing` (default) takes the cost the client reports and prices the tokens with the
 * `pricing` table when it reports none; `pricing_table` always prices the tokens; `provider_billing`
 * would read the usage API of the provider ([a confirmar por provedor]): it is accepted here, but
 * no adapter exists yet, so the service works as `client_then_pricing` and says so in the log.
 */
export const USAGE_COST_SOURCE_MODES = [
  'client_then_pricing',
  'pricing_table',
  'provider_billing',
] as const;
/**
 * [proposta] `usage.ccusage.command_mode` (P12, N118): how the `ccusage` executable is found.
 * `explicit` (default) takes `command` as an absolute path and looks nowhere else; `path` takes
 * `command` (default `ccusage`) as a name to search in `PATH`, which the owner has to choose.
 */
export const USAGE_CCUSAGE_COMMAND_MODES = ['explicit', 'path'] as const;
/** [proposta] `usage.ccusage.pricing`: `offline` (default) never lets the tool call the network. */
export const USAGE_CCUSAGE_PRICING_MODES = ['offline', 'online'] as const;
/**
 * [proposta] `usage.ccusage.compare`: what is set against the `UsageService`. `tokens` (default)
 * compares input plus output tokens; `tokens_and_cost` also compares the cost, when both sides know it.
 */
export const USAGE_CCUSAGE_COMPARE_MODES = ['tokens', 'tokens_and_cost'] as const;

/** `usage.api_gateway` (5.6): a gateway that meters the API traffic. Off in v1; no other mode yet. */
export const USAGE_API_GATEWAY_MODES = ['off'] as const;

/** The clients the daemon can run attempts with (the keys of `clients`). */
export const CLIENT_IDS = ['claude-code', 'codex', 'opencode'] as const;
export type ClientId = (typeof CLIENT_IDS)[number];
/**
 * Values of the keys that mirror an adapter's own list. The daemon imports adapters only in
 * `compose.ts`, so the lists are repeated here; `compose.test.ts` checks them against the adapters.
 */
export const CLIENT_ENV_INHERIT = ['minimal', 'none', 'all'] as const;
/**
 * `clients.<id>.version_source` (N63): where the version of a client comes from.
 * `auto` reads the `package.json` of the installed package and lets the `initialize` confirm or
 * correct it; `package_json` only reads the file; `initialize` only takes what the client says;
 * `config` takes only `client_version`. A `client_version` that is written wins in every mode.
 */
export const CLIENT_VERSION_SOURCES = ['auto', 'package_json', 'initialize', 'config'] as const;
export type ClientVersionSourceMode = (typeof CLIENT_VERSION_SOURCES)[number];
export const CLAUDE_SETTING_SOURCES = ['none', 'project', 'user'] as const;
/**
 * `clients.claude-code.utilization_unit` (N123): how the `utilization` of a `rate_limit_event`
 * is read. `ignore` (default) reads no number, `fraction` and `percent` fix the unit, and `auto`
 * takes 0..1 as a fraction and above 1 as a percentage and records the unit it saw. A value
 * outside 0..100 is refused with the reason in every mode.
 */
export const CLAUDE_UTILIZATION_UNITS = ['ignore', 'fraction', 'percent', 'auto'] as const;
/**
 * `clients.claude-code.quota_statusline` (P6): `file` (default) installs, in the `settings.json`
 * of each profile, a statusline command that keeps the quota windows in a file of the profile
 * directory, and the quota probe reads it; `off` installs nothing (and removes our own command),
 * so the probe has no reading and the profile stays `unknown` until a signal arrives.
 */
export const CLAUDE_QUOTA_STATUSLINES = ['file', 'off'] as const;
export const CLAUDE_ACCOUNT_ENV = ['strip', 'keep'] as const;
export const CLAUDE_MODEL_CATALOG_SOURCES = ['session', 'reserve', 'session_or_reserve'] as const;
export const CODEX_PROCESS_MODELS = ['multi-session', 'process-per-session'] as const;
/**
 * [proposta] Where the Codex model list comes from: `session` opens a session of the profile
 * without a prompt and reads its config options; `none` reads nothing (`models.list` rejects).
 */
export const CODEX_MODEL_CATALOG_SOURCES = ['session', 'none'] as const;

/**
 * [proposta] `clients.codex.quota.watch`: `off` reads the rate limits with one short `codex
 * app-server` per read (the default: one resident app-server costs about 114 MB, Phase 0 [V]); `resident`
 * keeps one per watched profile and takes its `account/rateLimits/updated` as well.
 */
export const CODEX_QUOTA_WATCH_MODES = ['off', 'resident'] as const;

export const CODEX_CREDENTIALS_STORES = ['file', 'keyring', 'auto'] as const;
export const CODEX_APPROVAL_POLICIES = ['on-request', 'untrusted'] as const;
/**
 * `clients.codex.inner_sandbox` (N129, owner's decision of 2026-11-18). What Codex does with its own
 * sandbox when layer 3 (`srt`) wraps it: `keep` (default; the client keeps `workspace-write`, whose
 * sandbox does not start inside the confinement, so its native shell fails and the roles with a shell
 * use the shells of the daemon), `full_access_when_wrapped` (with layer 3 on, Codex opens with no
 * sandbox of its own and `srt` is the only `os` layer), `nested` (with layer 3 on, `srt` lets this
 * client make user namespaces and Codex keeps its sandbox; the write denies of `srt` get weaker for
 * its process). Without layer 3 the last two behave as `keep`.
 */
export const CODEX_INNER_SANDBOX_MODES = ['keep', 'full_access_when_wrapped', 'nested'] as const;
/** Modes the adapter never selects (`agent` hands the escalation to a reviewer, `agent-full-access` asks nothing). */
export const CODEX_VETOED_MODES = ['agent', 'agent-full-access'] as const;
export const OPENCODE_ISOLATED_HOMES = ['data', 'config', 'state', 'cache'] as const;
export const OPENCODE_PROJECT_CONFIG = ['disabled', 'enabled'] as const;
export const OPENCODE_READ_ONLY_MODES = ['none', 'plan'] as const;
export const UNENFORCED_MODES = ['refuse', 'warn', 'allow'] as const;
/** `security.catalog_probe`: whether the session that only reads a catalog skips `unenforced`. */
export const CATALOG_PROBE_MODES = ['allow', 'refuse'] as const;
/**
 * `security.catalog_probe_log`: how often the daemon writes the `catalog_probe_exempt` warning.
 * `once`: once per client and adapter version in each run of the daemon; `every`: at every
 * catalog read; `off`: never.
 */
export const CATALOG_PROBE_LOG_MODES = ['once', 'every', 'off'] as const;
export const CONFORMANCE_MODES = ['on_version_change', 'every_start', 'off'] as const;
/**
 * `sandbox.mode` (architecture 5.8, layer 3): `runtime` confines the clients and the commands of
 * the daemon with the OS mechanism (bubblewrap on Linux, Seatbelt on macOS) where an adapter
 * exists; `off` turns layer 3 off, and then `security.unenforced` decides what happens to the
 * fields that only layer 3 guarantees (`writeScope`, `network`).
 */
export const SANDBOX_MODES = ['runtime', 'off'] as const;
/**
 * `sandbox.mcp_bridge` (N115, N161): how a confined client reaches the MCP server of the daemon,
 * which listens on the loopback of the host (a sandbox on Linux has its own loopback, and Seatbelt
 * on macOS refuses the loopback of the host with `EPERM`).
 *
 * - `proxy` (Linux): a listener inside the sandbox on the same port forwards to the host over the
 *   proxy of the sandbox library (TCP only, the Unix-socket filter stays on).
 * - `unix` (macOS): the server also listens on a Unix socket in a folder of the daemon, which
 *   Seatbelt lets the client connect to (and nothing else of that kind); the client gets the server
 *   as a stdio process, a shim that carries each message over that socket.
 * - `auto` (default): `unix` on macOS, `proxy` elsewhere.
 * - `off`: no bridge, only the `localhost:<port>` domain rule, which a client that honours
 *   `NO_PROXY` cannot use.
 */
/** `api.token`: how long the API token lives (P3 of docs/17). */
export const API_TOKEN_MODES = ['persistent', 'per_start'] as const;
export type ApiTokenMode = (typeof API_TOKEN_MODES)[number];

/** `api.remote`: where the API listens. Only `off` (loopback) works until Phase 12. */
export const API_REMOTE_MODES = ['off', 'vpn', 'proxy'] as const;
export type ApiRemoteMode = (typeof API_REMOTE_MODES)[number];

/** True for the text of an origin as a browser writes it: scheme, host, optional port, no path. */
function isOriginText(text: string): boolean {
  try {
    const url = new URL(text);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === text;
  } catch {
    return false;
  }
}

export const SANDBOX_MCP_BRIDGE_MODES = ['auto', 'proxy', 'unix', 'off'] as const;
export type SandboxMcpBridgeMode = (typeof SANDBOX_MCP_BRIDGE_MODES)[number];

/** The bridge `sandbox.mcp_bridge` stands for on this platform; `auto` resolved. Pure. */
export function resolveMcpBridge(
  mode: SandboxMcpBridgeMode,
  platform: NodeJS.Platform,
): Exclude<SandboxMcpBridgeMode, 'auto'> {
  if (mode === 'auto') return platform === 'darwin' ? 'unix' : 'proxy';
  if (mode === 'unix' && platform !== 'darwin') {
    throw new InvalidInput(
      'sandbox.mcp_bridge: unix works on macOS only (the sandbox of Linux blocks Unix sockets, N115); use proxy or auto',
    );
  }
  return mode;
}

/**
 * `events.unknown_type` (owner's decision N80, 2026-11-17): what `append` does with an event
 * whose type is not in the event registry or whose payload fails its schema. `reject` throws
 * and stores nothing; `warn` stores it and logs a warning.
 */
export const EVENT_UNKNOWN_TYPE_MODES = ['reject', 'warn'] as const;
export type EventUnknownTypeMode = (typeof EVENT_UNKNOWN_TYPE_MODES)[number];

/**
 * The `resume.preset` table of architecture 5.16 (decision N14): one row fills every value at once,
 * and an individual key overrides only its own value. `transient_backoff` does not change with the
 * preset ([proposta] in 5.16).
 */
export const RESUME_PRESETS = {
  balanced: {
    max_resumes: 5,
    max_free_resumes: 3,
    quota_wait_max: 30 * 60_000,
    checkpoint_every: 10 * 60_000,
    no_event_for: 10 * 60_000,
    same_error_times: 3,
  },
  patient: {
    max_resumes: 8,
    max_free_resumes: 3,
    quota_wait_max: 2 * 3_600_000,
    checkpoint_every: 15 * 60_000,
    no_event_for: 20 * 60_000,
    same_error_times: 5,
  },
  agile: {
    max_resumes: 3,
    max_free_resumes: 3,
    quota_wait_max: 10 * 60_000,
    checkpoint_every: 5 * 60_000,
    no_event_for: 5 * 60_000,
    same_error_times: 2,
  },
} as const;

export const LIMIT_PRESET_NAMES = ['moderate', 'economical', 'persistent'] as const;
export type LimitPresetName = (typeof LIMIT_PRESET_NAMES)[number];

/** The counters and timeouts of `limits` (architecture 5.4), as the pipeline reads them. */
export interface PlayLimits {
  readonly plan_reviews: number;
  readonly critic_rejections: number;
  readonly attempts_per_demand: number;
  readonly script_validations: number;
  readonly script_vetoes: number;
  readonly script_returns: number;
  readonly structural_restarts: number;
  readonly submit_retries: number;
  /** Milliseconds. */
  readonly demand_timeout: number;
  /** Milliseconds. */
  readonly demand_timeout_max: number;
}

/**
 * What `limits.on_turn_timeout` does when a turn of a session outlives `limits.turn_timeout`
 * (N184, [proposta]): `cancel` (default) cancels the session and ends the attempt as `timed_out`
 * with the cause `turn_timeout`, `notice` only writes the event `session.turn_timeout` and lets the
 * turn go on (the deadline of the attempt stays the cut), `off` turns the limit off.
 */
export const TURN_TIMEOUT_MODES = ['cancel', 'notice', 'off'] as const;
export type TurnTimeoutMode = (typeof TURN_TIMEOUT_MODES)[number];

/**
 * What `pause.mode` does with the work in flight when a play is paused (N176, owner, 2026-11-20):
 * `drain` (default) lets the running stage or Actor finish and opens nothing new; `interrupt`
 * interrupts the running attempts with the cause `paused`, saving the checkpoint, and they resume
 * where they stopped. The request of the pause may name its own mode.
 */
export const PAUSE_MODES = ['drain', 'interrupt'] as const;
export type PauseMode = (typeof PAUSE_MODES)[number];

/**
 * The resolved `limits` of the configuration: the values plus the name of the preset and the
 * limit of a single turn (N184), which is no counter of the pipeline and so is not in `PlayLimits`.
 */
export interface ResolvedLimits extends PlayLimits {
  readonly preset: LimitPresetName;
  /** Milliseconds: how long one turn (one prompt of a session) may take. */
  readonly turn_timeout: number;
  readonly on_turn_timeout: TurnTimeoutMode;
}

/**
 * `limits.turn_timeout` by preset, in milliseconds (N184). [proposta] Each one is below the
 * `demand_timeout` of its preset: the turn limit cuts a turn that does not end, the demand limit
 * cuts the demand as a whole.
 */
export const TURN_TIMEOUT_PRESETS: Readonly<Record<LimitPresetName, number>> = {
  moderate: 15 * 60_000,
  economical: 10 * 60_000,
  persistent: 25 * 60_000,
};

/**
 * The three presets of `limits` (architecture 5.4, table "Predefinição"; `submit_retries` is the
 * N79 column). A preset fills every value at once and an individual key overrides only its own.
 */
export const LIMIT_PRESETS: Readonly<Record<LimitPresetName, PlayLimits>> = {
  moderate: {
    plan_reviews: 2,
    critic_rejections: 2,
    attempts_per_demand: 3,
    script_validations: 3,
    script_vetoes: 2,
    script_returns: 2,
    structural_restarts: 1,
    submit_retries: 2,
    demand_timeout: 30 * 60_000,
    demand_timeout_max: 2 * 3_600_000,
  },
  economical: {
    plan_reviews: 1,
    critic_rejections: 1,
    attempts_per_demand: 2,
    script_validations: 2,
    script_vetoes: 1,
    script_returns: 1,
    structural_restarts: 0,
    submit_retries: 1,
    demand_timeout: 20 * 60_000,
    demand_timeout_max: 3_600_000,
  },
  persistent: {
    plan_reviews: 3,
    critic_rejections: 3,
    attempts_per_demand: 4,
    script_validations: 4,
    script_vetoes: 3,
    script_returns: 3,
    structural_restarts: 2,
    submit_retries: 3,
    demand_timeout: 45 * 60_000,
    demand_timeout_max: 3 * 3_600_000,
  },
};

/** Fills the keys the user did not write from the preset. */
function resolveLimits(
  limits: { preset: LimitPresetName } & { [K in keyof PlayLimits]?: number | undefined } & {
    turn_timeout?: number | undefined;
    on_turn_timeout: TurnTimeoutMode;
  },
): ResolvedLimits {
  const preset = LIMIT_PRESETS[limits.preset];
  const demandTimeout = limits.demand_timeout ?? preset.demand_timeout;
  return {
    preset: limits.preset,
    plan_reviews: limits.plan_reviews ?? preset.plan_reviews,
    critic_rejections: limits.critic_rejections ?? preset.critic_rejections,
    attempts_per_demand: limits.attempts_per_demand ?? preset.attempts_per_demand,
    script_validations: limits.script_validations ?? preset.script_validations,
    script_vetoes: limits.script_vetoes ?? preset.script_vetoes,
    script_returns: limits.script_returns ?? preset.script_returns,
    structural_restarts: limits.structural_restarts ?? preset.structural_restarts,
    submit_retries: limits.submit_retries ?? preset.submit_retries,
    demand_timeout: limits.demand_timeout ?? preset.demand_timeout,
    demand_timeout_max: limits.demand_timeout_max ?? preset.demand_timeout_max,
    // A preset value never goes above the demand limit the user wrote; a value the user wrote is
    // checked against it by the schema.
    turn_timeout:
      limits.turn_timeout ?? Math.min(TURN_TIMEOUT_PRESETS[limits.preset], demandTimeout),
    on_turn_timeout: limits.on_turn_timeout,
  };
}

export const VERIFY_MODES = ['run', 'skip'] as const;
export type VerifyMode = (typeof VERIFY_MODES)[number];

/**
 * What a rebase of a dependent onto the new branch of a redone dependency does when it
 * conflicts (architecture 5.5, N82). `redo`: a new attempt of the dependent from the new
 * dependency branch, with the old diff in the Actor's context (default); `script_failure`: the
 * conflict is a script failure; `resolve_attempt`: an attempt only to resolve the conflict.
 */
export const REBASE_CONFLICT_MODES = ['redo', 'script_failure', 'resolve_attempt'] as const;
export type RebaseConflictMode = (typeof REBASE_CONFLICT_MODES)[number];

/**
 * What the delivery does when the project's base moved while the play ran (N83). `update`: merge
 * the base into the integration and run `verify` again (default); `deliver_and_warn`: open the PR
 * with the conflicts listed; `ask`: the Producer chooses (with nobody watching it is `update`).
 */
export const BASE_DRIFT_MODES = ['update', 'deliver_and_warn', 'ask'] as const;
export type BaseDriftMode = (typeof BASE_DRIFT_MODES)[number];

/**
 * [proposta] What the daemon does when the Producer leaves while the question of
 * `delivery.mode: ask` waits (N89, P9). `pr` (default, the safe side): once the chat is no longer
 * present the play goes on with the PR; `wait`: it keeps waiting for the Producer to come back
 * (until `delivery.ask.timeout`, if there is one).
 */
export const DELIVERY_ASK_LEAVE_MODES = ['pr', 'wait'] as const;
export type DeliveryAskLeaveMode = (typeof DELIVERY_ASK_LEAVE_MODES)[number];

/**
 * `profiles.same_provider_notice` (Phase 5, P2; N127 decided the drain keys on 2026-11-18, this one stays
 * [proposta]). When registering a second
 * subscription profile of the same provider: `once` warns until the Producer accepts it (the
 * acceptance is recorded on the profile, `noticeAcceptedAt`, and a later profile of that provider is
 * not warned again); `always` warns on every such profile; `off` never warns. An API profile never
 * triggers it, in any mode.
 */
export const SAME_PROVIDER_NOTICE_MODES = ['once', 'always', 'off'] as const;
export type SameProviderNoticeMode = (typeof SAME_PROVIDER_NOTICE_MODES)[number];

/**
 * `profiles.exec.env_inherit` (P28a, N159) [proposta]: the environment `ot profile exec` gives the
 * official CLI. `terminal` (default) is the environment of the person's terminal, without what the
 * adapter says points at another account or profile (`ProfileCli.unsetEnv`), plus the variables of
 * the profile and, for an API profile, its key from the vault. `client` starts instead from the
 * minimal environment the daemon gives an Executor (`clients.*.env` included), the strict mode.
 */
export const PROFILE_EXEC_ENV_INHERIT_MODES = ['terminal', 'client'] as const;
export type ProfileExecEnvInheritMode = (typeof PROFILE_EXEC_ENV_INHERIT_MODES)[number];

/**
 * `profiles.shims.mode` (P28b, N159; owner, 2026-11-19, [proposta] for the modes): the commands by
 * profile in `<data>/bin`. `auto` (default) writes and removes them as profiles are added and removed;
 * `manual` writes them only on `ot profile shims sync`; `off` writes none (the ones already there
 * stay until a sync in another mode).
 */
export const PROFILE_SHIMS_MODES = ['auto', 'manual', 'off'] as const;
export type ProfileShimsMode = (typeof PROFILE_SHIMS_MODES)[number];

/** `profiles.shims.prefix`: empty by default (owner, N159); letters, digits, `.`, `_` and `-`. */
export const SHIM_PREFIX = /^[A-Za-z0-9._-]*$/;

/** A common name of `ot profile exec`, or a client id: lower case, digits and `-`. */
const CommonNameSchema = z.string().regex(COMMON_NAME, 'expected lower case, digits and -');

/** `profiles.commands` and `profiles.options`: by common name, then by client id, the tokens. */
const commonWordsSchema = (minTokens: number) =>
  z
    .record(CommonNameSchema, z.record(CommonNameSchema, z.array(z.string().min(1)).min(minTokens)))
    .default({});

/**
 * `profiles.drain.on_timeout` (Phase 5, P2 and P21; N127, decided 2026-11-18: default `handoff`).
 * What happens to the sessions still running when `profiles.drain.timeout` ends: `handoff` takes
 * them off the profile and passes the baton (P18) to the next Executor of the role, so the demand
 * is not lost; `wait` keeps the profile `draining` until they end; `force` stops them (their
 * attempts stay `awaiting_resume`) and ends the client processes of the profile.
 */
export const DRAIN_ON_TIMEOUT_MODES = ['handoff', 'wait', 'force'] as const;
export type DrainOnTimeoutMode = (typeof DRAIN_ON_TIMEOUT_MODES)[number];

/**
 * [proposta] (P21b, N153) `profiles.drain.director`: what a drain does with the Director (and the
 * consultant) whose session stands on the profile that leaves: `failover` moves the Director to the
 * next Executor of its list (the failover of P20, cause `profile_removed`) and closes the standing
 * session of the consultant, so the removal is not held; `wait` is the behaviour before P21b: the
 * session holds its lease and the removal waits for it (`Conflict`, until it sleeps or `force`).
 */
export const DRAIN_DIRECTOR_MODES = ['failover', 'wait'] as const;
export type DrainDirectorMode = (typeof DRAIN_DIRECTOR_MODES)[number];

/**
 * `profiles.drain.removed_dir` (Phase 5, P2 and P21; N127, decided 2026-11-18: default `delete`).
 * What removal does with the directory of the profile, after the logout: `delete` removes it;
 * `keep_backup` moves it to `<data>/profiles/.removed/<client>-<name>-<epoch>` instead of deleting.
 * Either way only a directory inside `<data>/profiles` is touched.
 */
export const REMOVED_DIR_MODES = ['delete', 'keep_backup'] as const;
export type RemovedDirMode = (typeof REMOVED_DIR_MODES)[number];

/**
 * What the daemon does with the conventions of a repository the Producer imports (architecture
 * 5.20; P7). `ask` (default): it detects them and asks the Producer to confirm or correct them,
 * in the chat, until they do; `detect`: it detects them and uses them as they are, without asking;
 * `off`: it detects nothing and a delivery follows no convention of the project.
 */
export const CONVENTIONS_MODES = ['ask', 'detect', 'off'] as const;
export type ConventionsMode = (typeof CONVENTIONS_MODES)[number];

/**
 * Does a delivery keep a changelog? (N100, architecture 5.20.) `always` (default): every delivery
 * adds its entry, creating `CHANGELOG.md` in Keep a Changelog format when the repository has none;
 * `auto`: only when the repository has one or the project is new; `never`: it does not touch it.
 * A scenario overrides it with `delivery.changelog` in its `config_override`.
 */
export const CHANGELOG_MODES = ['auto', 'always', 'never'] as const;
export type ChangelogMode = (typeof CHANGELOG_MODES)[number];

/**
 * What a new script does with the demands the old one had already done (N84).
 * `keep_unchanged`: the demands the Scriptwriter marks as unchanged (and that the daemon finds
 * equal) stay approved (default); `redo_all`: everything is redone; `from_previous`: the demands
 * start from the branch of their old attempt.
 */
export const RESCRIPT_REUSE_MODES = ['keep_unchanged', 'redo_all', 'from_previous'] as const;
export type RescriptReuseMode = (typeof RESCRIPT_REUSE_MODES)[number];

/**
 * `recovery.notice` [proposta]: when the reconciliation of a start-up tells the chat of a scenario
 * (architecture 5.21, step 8). `always` (default): every scenario it touched, a clean restart that
 * only took plays up again included; `unclean_only`: only when something was settled by a verifier
 * or waits for the Producer (an effect nobody could check, a play that could not be restored);
 * `off`: no event and no message.
 */
export const RECOVERY_NOTICE_MODES = ['always', 'unclean_only', 'off'] as const;
export type RecoveryNoticeMode = (typeof RECOVERY_NOTICE_MODES)[number];

/**
 * Who counts as watching a play (decision of P15a, [proposta]; renamed in N175, 2026-11-20, from
 * `poll` with no alias: the old name is an invalid value). `connected` (default): an `ot chat`
 * connected to the scenario of the play, that is, with its chat WebSocket open, or that polled it
 * within `chat.presence_window`; `always`: someone is always
 * there (the Producer is trusted to answer); `never`: nobody is, so `delivery.base_drift: ask`
 * acts as `update`.
 */
export const CHAT_PRESENCE_MODES = ['connected', 'always', 'never'] as const;
export type ChatPresenceMode = (typeof CHAT_PRESENCE_MODES)[number];

/**
 * `chat.silent_turn` (N183, decision of the owner of 2026-11-20): what the chat gets when a turn of
 * the Director ends without any text (a real OpenCode round opened a play with the framework tool
 * and said nothing [V]; why the model stayed silent is not confirmed [N]). `notice` (default): the
 * daemon keeps a short reply generated from the tools the turn called (and the play it opened), marked
 * `generated: true` in `chat.director_reply`, so the Producer is never left without an answer;
 * `none`: nothing reaches the chat. In both modes the situation is the event `chat.director_silent`.
 * A turn that failed is not a silent turn: it keeps its `[error]` reply.
 */
export const SILENT_TURN_MODES = ['notice', 'none'] as const;
export type SilentTurnMode = (typeof SILENT_TURN_MODES)[number];

/**
 * `chat.slash_commands` (Phase 7, P3; architecture 5.13): `on` sends a line that starts with `/` to
 * the registry of commands of the daemon (an unknown one is refused); `off` keeps the old
 * behaviour, the line goes to the Director as typed.
 */
export const SLASH_COMMAND_MODES = ['on', 'off'] as const;
export type SlashCommandMode = (typeof SLASH_COMMAND_MODES)[number];

/**
 * `chat.client_commands` (P3): the `/` commands of the client of the Director (`/claude:compact`).
 * `on`: all of those the client announced; `off`: none; `allowlist`: only those in
 * `chat.client_commands_allow`.
 */
export const CLIENT_COMMAND_MODES = ['on', 'off', 'allowlist'] as const;
export type ClientCommandMode = (typeof CLIENT_COMMAND_MODES)[number];

/** `chat.slash_confirm` (P3): `always` asks before a command that marks itself as asking; `never` runs it at once. */
export const SLASH_CONFIRM_MODES = ['always', 'never'] as const;
export type SlashConfirmMode = (typeof SLASH_CONFIRM_MODES)[number];

/**
 * `chat.slash_access` (P3): what the `/` commands may do. `full`: all of them; `read_only`: only the
 * ones that read (the registry marks each as `read` or `write`), the others are refused with
 * `forbidden`.
 */
export const SLASH_ACCESS_MODES = ['full', 'read_only'] as const;
export type SlashAccessMode = (typeof SLASH_ACCESS_MODES)[number];

/**
 * The templates for the Director (`/plan fix the login`): the name of the command and the text the
 * Producer's words follow. [proposta] They are prompts, so they are in English like every prompt of
 * the daemon (5.22); the Producer's own templates go in `chat.slash_templates`.
 */
export const DEFAULT_SLASH_TEMPLATES: Readonly<Record<string, string>> = {
  plan: 'Make a plan, without changing anything yet, for: ',
  explain: 'Explain: ',
  review: 'Review the work done so far and tell me what is missing: ',
};

/**
 * `tools.shell_allowlist.mode` (N97): which programs `restricted_shell` runs. `list` (default):
 * the entries of `tools.shell_allowlist.list`; `profile`: only the commands of the project
 * conventions (`scenarios.conventions`); `any`: any program of the PATH (the sandbox, P4, is the
 * only container). The argv rules and the confinement of the paths apply in all three.
 */
export const SHELL_ALLOWLIST_MODES = ['list', 'profile', 'any'] as const;
export type ShellAllowlistMode = (typeof SHELL_ALLOWLIST_MODES)[number];

/** The tools that can count toward `tools.heavy_concurrency` (`tools.heavy_commands`). [proposta] */
export const HEAVY_TOOL_NAMES = ['restricted_shell', 'run_tests', 'install_deps'] as const;
export type HeavyToolName = (typeof HEAVY_TOOL_NAMES)[number];

/**
 * `tools.http.redirects`: what `http_get` does with a 3xx answer. `refuse` (default):
 * the answer is the redirect itself, nothing is followed (default, owner decision of
 * 2026-11-17); `follow_allowed`: it follows a redirect
 * only while the target is also in the role's `network.allow` (at most 5 hops).
 */
export const HTTP_REDIRECT_MODES = ['refuse', 'follow_allowed'] as const;
export type HttpRedirectMode = (typeof HTTP_REDIRECT_MODES)[number];

/**
 * `tools.effects.mode` [proposta] (P22, architecture 5.16 and 5.21): whether the commands that
 * change the worktree write their "before" and "after" in `side_effects`. `record` (default): they
 * do, so a resume finds what was done; `off`: they do not (what the three tools did before P22).
 */
export const EFFECT_RECORD_MODES = ['record', 'off'] as const;
export type EffectRecordMode = (typeof EFFECT_RECORD_MODES)[number];

/**
 * `tools.effects.replay` [proposta]: what `install_deps` does when the same call comes again (the
 * same command over the same dependency files) and the earlier run finished. `same_inputs`
 * (default, as 5.16 says): the recorded result is returned and nothing runs; `never`: it runs
 * again, as a new step. A run that failed or timed out is never replayed.
 */
export const EFFECT_REPLAY_MODES = ['same_inputs', 'never'] as const;
export type EffectReplayMode = (typeof EFFECT_REPLAY_MODES)[number];

/**
 * `tools.effects.open_command` [proposta]: what a command with a "before" and no "after" (the
 * daemon died in the middle of it) becomes. `rerun_safe` (default): `install_deps` and
 * `run_tests` run from the command of the project and converge, so their verifier answers "not
 * done" and the next call runs again; `restricted_shell` has no verifier, so it stays ambiguous
 * and the Producer decides; `ask`: all three stay ambiguous for the Producer.
 */
export const EFFECT_OPEN_COMMAND_MODES = ['rerun_safe', 'ask'] as const;
export type EffectOpenCommandMode = (typeof EFFECT_OPEN_COMMAND_MODES)[number];

/**
 * The files whose content says whether an install is still current (`tools.effects.
 * fingerprint_files`). [proposta] The manifests and lockfiles of the usual ecosystems.
 */
export const DEFAULT_FINGERPRINT_FILES = [
  'package.json',
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'pyproject.toml',
  'poetry.lock',
  'uv.lock',
  'requirements.txt',
  'Cargo.toml',
  'Cargo.lock',
  'go.mod',
  'go.sum',
  'Gemfile',
  'Gemfile.lock',
  'composer.json',
  'composer.lock',
] as const;

/** A command of the project (`tools.commands.*`): a line, split without a shell, or an argv. Same schema as `scenarios.conventions.commands`. */
export const ToolCommandSchema = ProjectCommandSchema;
export type ToolCommand = z.infer<typeof ToolCommandSchema>;

export const AllowlistEntrySchema = z
  .string()
  .min(1)
  .refine((entry) => {
    try {
      parseAllowEntry(entry);
      return true;
    } catch {
      return false;
    }
  }, 'expected a bare program name and optional leading words, such as "git status"');

/**
 * `tools` (architecture 5.8, N97 and N98): the work tools of the Executors. The scenario and the
 * project can override every key (`resolveToolSettings`).
 */
export const ToolsConfigSchema = z
  .strictObject({
    /** N97: which programs `restricted_shell` runs. */
    shell_allowlist: z
      .strictObject({
        mode: z.enum(SHELL_ALLOWLIST_MODES).default('list'),
        /** The entries of mode `list`: a program and, optionally, the words that must follow it. */
        list: z.array(AllowlistEntrySchema).default([...DEFAULT_SHELL_ALLOWLIST]),
      })
      .prefault({}),
    /** N98: the longest a command runs; at the end the process tree is killed. */
    timeout_ms: z.int().min(1).default(600_000),
    /** N98: the most bytes of stdout, of stderr or of a body that go back to the Executor. */
    output_max_bytes: z.int().min(1).default(65_536),
    /** [proposta] Which part of a long output is kept: `head`, `tail` or `head_tail` (default). */
    truncate: z.enum(TRUNCATE_MODES).default('head_tail'),
    /** N98: how many heavy commands run at once; the others wait their turn. */
    heavy_concurrency: z.int().min(1).default(1),
    /** [proposta] The tools that count as heavy. */
    heavy_commands: z.array(z.enum(HEAVY_TOOL_NAMES)).default(['run_tests', 'install_deps']),
    /**
     * [proposta] The commands `run_tests` and `install_deps` run when the conventions of the
     * project (`scenarios.conventions`) say none. Never from the model.
     */
    commands: z
      .strictObject({
        test: ToolCommandSchema.optional(),
        install: ToolCommandSchema.optional(),
      })
      .prefault({}),
    /**
     * [proposta] The environment a command starts from, as `clients.*.env_inherit`: `minimal`
     * (default: PATH, HOME, locale, proxy), `none` or `all`. Global only: a scenario cannot widen
     * it. The credentials of the clients are not in the minimal list.
     */
    env_inherit: z.enum(['minimal', 'none', 'all']).default('minimal'),
    /** [proposta] Names added to the environment of a command (`env_inherit`: `minimal` or `none`). */
    env_allow: z.array(z.string().min(1)).default([]),
    /**
     * [proposta] P22: the "before" and "after" of the commands in `side_effects` (5.16 and 5.21),
     * the replay of `install_deps` and what an interrupted command becomes.
     */
    effects: z
      .strictObject({
        mode: z.enum(EFFECT_RECORD_MODES).default('record'),
        replay: z.enum(EFFECT_REPLAY_MODES).default('same_inputs'),
        open_command: z.enum(EFFECT_OPEN_COMMAND_MODES).default('rerun_safe'),
        /** Paths inside the worktree whose content is part of the call of `install_deps`. */
        fingerprint_files: z
          .array(
            z
              .string()
              .min(1)
              .refine(
                (path) =>
                  !path.startsWith('/') &&
                  !path.startsWith('\\') &&
                  !/^[A-Za-z]:/.test(path) &&
                  !path.split(/[\\/]/).includes('..'),
                'expected a path inside the worktree',
              ),
          )
          .default([...DEFAULT_FINGERPRINT_FILES]),
      })
      .prefault({}),
    /** [proposta] `http_get`: the time limit of a request and what a redirect does. */
    http: z
      .strictObject({
        timeout_ms: z.int().min(1).default(30_000),
        redirects: z.enum(HTTP_REDIRECT_MODES).default('refuse'),
      })
      .prefault({}),
  })
  .prefault({});
export type ToolsConfig = z.infer<typeof ToolsConfigSchema>;

export const BROWSER_PROFILE_CONFIG_MODES = [
  'extension',
  'import',
  'shared',
  'per_scenario',
] as const;
export const BROWSER_FALLBACK_MODES = ['shared', 'wait', 'fail'] as const;
export const BROWSER_DOMAIN_MODES = ['any', 'allowlist'] as const;
export const BROWSER_LOCAL_URL_MODES = ['allow', 'deny'] as const;
export const BROWSER_FILE_URL_MODES = ['except_secrets', 'any', 'scenario', 'deny'] as const;
export const BROWSER_WRITE_APPROVAL_MODES = ['never', 'per_domain', 'always'] as const;
export const BROWSER_SCREENSHOT_MODES = ['writes', 'all', 'none'] as const;
export type BrowserFileUrlMode = (typeof BROWSER_FILE_URL_MODES)[number];
export type BrowserWriteApprovalMode = (typeof BROWSER_WRITE_APPROVAL_MODES)[number];

/**
 * `browser` (architecture 5.19, N40): the browser of the agent without the screen. The defaults
 * are the ones the owner chose (N40: no restrictions); a project or a scenario overrides the
 * keys of `BrowserOverrideSchema` (browser/settings.ts). Keys marked [proposta] are choices of
 * Phase 4 the architecture leaves open.
 */
export const BrowserConfigSchema = z
  .strictObject({
    /**
     * N40: `extension` (default) is the Producer's own browser, an adapter of Phase 12; until then
     * it falls to `fallback`. `import` [proposta] is Phase 12 too, and the call is refused.
     * `shared` is one profile of OTheater for every scenario, `per_scenario` one for each.
     */
    profile: z.enum(BROWSER_PROFILE_CONFIG_MODES).default('extension'),
    /** [proposta] What `profile: extension` does while no extension is connected. */
    fallback: z.enum(BROWSER_FALLBACK_MODES).default('shared'),
    /** N40: `any` (default) or `allowlist`, the `network.allow` of the role, as `http_get`. */
    domains: z.enum(BROWSER_DOMAIN_MODES).default('any'),
    /** [proposta] Hosts refused in every `domains` mode, as `network.allow` writes them. */
    blocked_domains: z.array(z.string().min(1)).default([]),
    /** N40: `localhost`, `127.0.0.1`, `[::1]` and `*.localhost`, any port. */
    local_urls: z.enum(BROWSER_LOCAL_URL_MODES).default('allow'),
    /** N40: what `file://` may reach. The daemon enforces it, not the browser. */
    file_urls: z.enum(BROWSER_FILE_URL_MODES).default('except_secrets'),
    /** N40: `never` (default), `per_domain` or `always`; the Producer answers in the chat. */
    write_approval: z.enum(BROWSER_WRITE_APPROVAL_MODES).default('never'),
    /** [proposta] Which actions leave a screenshot with their `browser.action` event. */
    action_screenshots: z.enum(BROWSER_SCREENSHOT_MODES).default('writes'),
    /** [proposta] The most characters `browser_read` returns, for the text and for the tree. */
    read_max_chars: z.int().min(1).default(32_768),
    /** [proposta] The longest a page action (open, click, fill...) waits. Global only. */
    timeout_ms: z.int().min(1).default(30_000),
    /** [proposta] RAM admission (5.9): no browser starts below this much free memory. Global only. */
    min_free_memory_mb: z.int().min(0).default(1024),
    /** [proposta] The most browsers at once (only `per_scenario` has more than one). Global only. */
    max_instances: z.int().min(1).default(2),
    /** [proposta] `false` starts Chromium with `--no-sandbox`: only where the sandbox cannot run. Global only. */
    sandbox: z.boolean().default(true),
    /** [proposta] The Chromium executable; unset, the one playwright-core finds in its cache. Global only. */
    executable_path: z.string().min(1).optional(),
    /**
     * [proposta] A scenario whose browser has not been used for this long is closed (its page, and
     * the browser with it when it was the last one); `0` never closes. Global only.
     */
    idle_close_ms: z.int().min(0).default(600_000),
    /**
     * [proposta] An alias of `security.secret_paths` (same `add`/`remove`, same list: the Sandbox and
     * `browser_open` share it, 5.19). Write it in one place: both with entries is refused. Global only.
     */
    secret_paths: z
      .strictObject({
        add: z.array(z.string().min(1)).default([]),
        remove: z.array(z.string().min(1)).default([]),
      })
      .prefault({}),
  })
  .prefault({});
export type BrowserConfig = z.infer<typeof BrowserConfigSchema>;

/** An Executor as `orchestration.executor` and `orchestration.roles.<role>` write it. */
export const PlayExecutorSchema = z.strictObject({
  client: z.string().min(1),
  profile: z.string().min(1),
  model: z.string().min(1),
  effort: z.string().min(1).optional(),
  mode: z.string().min(1).optional(),
});
export type PlayExecutor = z.infer<typeof PlayExecutorSchema>;

/** `all` (one step for the whole database) or a page count per step, an integer >= 1. */
export const PagesPerStepSchema = z.union([z.literal('all'), z.int().min(1)]);

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const PriceRatesConfigSchema = z.strictObject({
  input_per_mtok: z.number().min(0),
  output_per_mtok: z.number().min(0),
  cache_read_per_mtok: z.number().min(0).optional(),
  cache_write_per_mtok: z.number().min(0).optional(),
});

/** One entry of `pricing` (architecture 5.6): the price of a model in US$ per million tokens. */
export const ModelPriceConfigSchema = PriceRatesConfigSchema.extend({
  cached_in_input: z.boolean().optional(),
  long_context: PriceRatesConfigSchema.extend({ over_tokens: z.int().min(1) }).optional(),
});
export type ModelPriceConfig = z.infer<typeof ModelPriceConfigSchema>;

/**
 * `command` of a client: the executable (a name looked up in `PATH`, or a path) and its arguments.
 * Without `args` the client's own default applies (`acp` for OpenCode, none for the others).
 */
const ClientCommandSchema = z.strictObject({
  cmd: z.string().min(1),
  args: z.array(z.string()).optional(),
});

/**
 * Keys every client has. [proposta] names, `clients.<id>.*` (architecture 5.2).
 *
 * - `enabled`: `auto` turns the client on when its `command` is set or the default executable is
 *   found in `PATH` (a search in code that never runs the binary); `true` and `false` decide.
 * - `client_version`: the version of the client, written by the user. It wins over every other
 *   source. The daemon never runs the client to learn it; it goes into the adapter version (the key
 *   of the conformance cache). Left as `unknown`, `version_source` decides where it comes from.
 * - `version_source`: `auto` (default; the `package.json` of the installed package, then the
 *   `initialize` of the first session confirms or corrects it), `package_json`, `initialize` or
 *   `config` (only `client_version`). N63.
 * - `version_packages`: the names the `package.json` search accepts; default is the ACP adapter of
 *   the client (`@agentclientprotocol/claude-agent-acp`, `@agentclientprotocol/codex-acp`) or the
 *   client itself (`opencode-ai`), the program whose `initialize` gives the version.
 * - `env_inherit`: what of the daemon's own environment reaches the client: `minimal` (the
 *   variables a program needs to run, plus proxy and certificate ones), `none` or `all`. `all`
 *   passes every variable of the daemon, secrets included; it is there for who wants it, not a default.
 * - `env_allow`: names to add from the daemon's environment on top of `env_inherit`.
 * - `env`: literal variables, applied last. Not for secrets: the config file is plain text.
 */
const clientCommon = {
  enabled: z.union([z.literal('auto'), z.boolean()]).default('auto'),
  client_version: z.string().min(1).default('unknown'),
  version_source: z.enum(CLIENT_VERSION_SOURCES).default('auto'),
  version_packages: z.array(z.string().min(1)).min(1).optional(),
  env_inherit: z.enum(CLIENT_ENV_INHERIT).default('minimal'),
  env_allow: z.array(z.string().regex(ENV_NAME, 'expected a variable name')).default([]),
  env: z.record(z.string().regex(ENV_NAME, 'expected a variable name'), z.string()).default({}),
};

/** `clients.claude-code` (keys of `ClaudeCodeAdapterOptions`). */
export const ClaudeCodeClientSchema = z.strictObject({
  ...clientCommon,
  /** Default `claude-agent-acp`. */
  command: ClientCommandSchema.optional(),
  setting_sources: z.enum(CLAUDE_SETTING_SOURCES).default('none'),
  utilization_unit: z.enum(CLAUDE_UTILIZATION_UNITS).default('ignore'),
  quota_statusline: z.enum(CLAUDE_QUOTA_STATUSLINES).default('file'),
  account_env: z.enum(CLAUDE_ACCOUNT_ENV).default('strip'),
  model_catalog: z.enum(CLAUDE_MODEL_CATALOG_SOURCES).default('session_or_reserve'),
  model_catalog_cache: DurationSchema.or(z.literal(0)).prefault('5m'),
});

/** `clients.codex` (keys of `CodexAdapterOptions`). */
export const CodexClientSchema = z.strictObject({
  ...clientCommon,
  /** Default `codex-acp`. */
  command: ClientCommandSchema.optional(),
  process_model: z.enum(CODEX_PROCESS_MODELS).default('multi-session'),
  initial_mode: z.string().min(1).default('workspace-write'),
  modes: z.array(z.string().min(1)).min(1).default(['read-only', 'workspace-write']),
  credentials_store: z.enum(CODEX_CREDENTIALS_STORES).default('file'),
  approval_policy: z.enum(CODEX_APPROVAL_POLICIES).default('on-request'),
  inner_sandbox: z.enum(CODEX_INNER_SANDBOX_MODES).default('keep'),
  suggested_effort: z.string().min(1).default('high'),
  model_catalog: z.enum(CODEX_MODEL_CATALOG_SOURCES).default('session'),
  /**
   * [proposta] The quota probe (architecture 5.6): `command` starts the app-server (default `codex
   * app-server`), `timeout` ends a read that does not answer, `watch` is `off` or `resident`, and
   * `windows` is the list of window names the probe promises to report (default none: the ones the
   * account has).
   */
  quota: z
    .strictObject({
      command: ClientCommandSchema.optional(),
      timeout: DurationSchema.prefault('15s'),
      watch: z.enum(CODEX_QUOTA_WATCH_MODES).default('off'),
      windows: z.array(z.string().min(1)).default([]),
    })
    .prefault({}),
});

/** `pool.<client>.session_mb`: the cost of a session in MB, or `auto`. */
const SessionMbSchema = z.union([z.literal('auto'), z.int().min(1)]);

/**
 * `pool.<client>`: what the pool decides for one client alone. `sessions_per_process` (`K`) has a
 * default of its own only where a real measurement justified one (N74, owner's decision,
 * 2026-11-16: Codex 6, OpenCode 4); a client without one (Claude Code) inherits the global
 * `pool.sessions_per_process`.
 */
export const PoolClientSchema = z.strictObject({
  /** `K` of this client; absent: `pool.sessions_per_process`. */
  sessions_per_process: z.int().min(1).optional(),
  /**
   * [proposta] What one session of this client costs in MB, for the RAM admission
   * (`pool.admission.mode: ram | ram_and_quota`, 5.9): a number, or `auto` (the pool measures the
   * process tree of the client and keeps the largest share it saw). Each client has a default of
   * its own, taken from the measurement of N74 (2026-11-16, PSS per session after a prompt, rounded up).
   */
  session_mb: SessionMbSchema.default(FALLBACK_SESSION_MB),
});

/** `pool.claude-code`: `session_mb` defaults to 320 (N74 measured 313.6 MB). */
export const PoolClaudeCodeSchema = PoolClientSchema.extend({
  session_mb: SessionMbSchema.default(DEFAULT_SESSION_MB['claude-code']),
});

/** `pool.codex`: `K` defaults to 6 (N74, measured on 2026-11-16); `session_mb` to 150 (N74: 150.1 MB). */
export const PoolCodexSchema = PoolClientSchema.extend({
  sessions_per_process: z.int().min(1).default(6),
  session_mb: SessionMbSchema.default(DEFAULT_SESSION_MB.codex),
});

/** `clients.opencode` (keys of `OpenCodeAdapterOptions`; `pool.opencode.process_model` is under `pool`). */
export const OpenCodeClientSchema = z.strictObject({
  ...clientCommon,
  /** Default `opencode acp`. */
  command: ClientCommandSchema.optional(),
  /**
   * The homes moved into the profile. `state` is in the default (Phase 4 [V]): the client takes
   * locks there before it reaches an MCP server, and the sandbox keeps the user's own read-only.
   */
  isolation: z.array(z.enum(OPENCODE_ISOLATED_HOMES)).default(['data', 'config', 'state']),
  /** The `opencode.json` of the profile: an object, `null` for no file, absent for the adapter's default. */
  profile_config: z.record(z.string(), z.unknown()).nullable().optional(),
  shell_keys: z.array(z.string().min(1)).min(1).default(['bash']),
  /** Tools that change only the session (its to-do list): `allow` for every role; `[]` sends them to `ask`. */
  internal_tools: z.array(z.string().min(1)).default(['todowrite', 'todoread']),
  project_config: z.enum(OPENCODE_PROJECT_CONFIG).default('disabled'),
  read_only_mode: z.enum(OPENCODE_READ_ONLY_MODES).default('none'),
  /** How long `opencode models` is reused (`models_cache`); `0` reads every time. */
  models_cache: DurationSchema.or(z.literal(0)).prefault('1m'),
  suggest: z
    .strictObject({
      effort_preference: z.array(z.string().min(1)).min(1).default(['medium', 'low', 'high']),
    })
    .prefault({}),
  /** A context window below this is reported by `validate`; absent: not checked. */
  min_context_window: z.int().min(1).optional(),
  context_severity: z.enum(['warning', 'error']).default('warning'),
  /** The permission probe (architecture 5.2): the model it runs with (absent: the client's own) and how long it waits. */
  permission_probe: z
    .strictObject({
      model: z.string().min(1).optional(),
      timeout: DurationSchema.prefault('2m'),
    })
    .prefault({}),
  /** Longest wait for a profile turn (the file of a session being written). */
  slot_timeout: DurationSchema.prefault('30s'),
});

/** A section whose keys belong to an adapter: `compose.ts` validates it with the adapter's schema. */
const AdapterSection = z.record(z.string(), z.unknown());

/** A duration, or `off` (no deadline: `null` once parsed). */
const OffOrDurationSchema = z.union([z.literal('off').transform(() => null), DurationSchema]);

const ShellCommandSectionSchema = z.strictObject({
  mode: z.enum(SHELL_COMMAND_MODES).default('on'),
  timeout: OffOrDurationSchema.prefault(SHELL_TIMEOUT_DEFAULT),
  context: z.enum(SHELL_CONTEXT_MODES).default('auto'),
  /** [proposta] How many `!` commands of one scenario may run at once. */
  max_running: z.int().min(1).default(4),
});

/**
 * `chat.shell_command` is `on` | `off` (the scalar) or a section with `mode`, `timeout` and
 * `context`; both normalise to the section, so `chat.shell_command: off` and
 * `chat.shell_command.timeout: 30s` are each valid on their own.
 */
const ShellCommandConfigSchema = z
  .union([
    z.enum(SHELL_COMMAND_MODES).transform((mode) => ShellCommandSectionSchema.parse({ mode })),
    ShellCommandSectionSchema,
  ])
  .prefault({});

const TerminalConfigSchema = z
  .strictObject({
    snippet: z
      .strictObject({
        max_lines: z.int().min(1).default(200),
        keep: z.enum(SNIPPET_KEEP_MODES).default('tail'),
      })
      .prefault({}),
    log_max_size: SizeSchema.refine((bytes) => bytes > 0, 'expected a size above zero').prefault(
      '16MB',
    ),
  })
  .prefault({});

/** [proposta] The direct session with an Actor (P19, N44, N190): see `direct/direct-config.ts`. */
const DirectSessionConfigSchema = z
  .strictObject({
    workspace: z.enum(DIRECT_WORKSPACES).default('worktree'),
    confirm_scenario: z.enum(DIRECT_CONFIRM_MODES).default('ask'),
    max_open: z.int().min(1).default(3),
    on_close: z.enum(DIRECT_ON_CLOSE_MODES).default('keep'),
    history_max: z.int().min(1).default(200),
    closed_kept: z.int().min(0).default(10),
    idle_timeout: OffOrDurationSchema.prefault(DIRECT_IDLE_TIMEOUT_DEFAULT),
    orphans: z.enum(DIRECT_ORPHANS_MODES).default('on_close'),
  })
  .prefault({});

/** `telemetry.enabled`, `telemetry.clients.<client>` and `telemetry.clients.<client>.<option>`: on or off. */
export const TELEMETRY_SWITCH_MODES = ['on', 'off'] as const;
/**
 * `telemetry.daemon_spans.waits` (Phase 8, P4, P15; [proposta]): whether the daemon makes the
 * `otheater.wait` spans. `all`: every wait the log tells (quota, executor selection, tool
 * semaphore, and the prompt queue and the pool past `events.wait_threshold`, P15); `off`: none.
 * Every span is made from the log, so a recreated base gets them all again.
 */
export const TELEMETRY_DAEMON_WAITS_MODES = ['all', 'off'] as const;
/**
 * `events.wait_threshold` (Phase 8, P15, N222 (a); [proposta]): how long a wait of the prompt queue
 * or of the pool must last to be told in the log (`wait.started`, `wait.ended`). A duration (default
 * `1s`); `always`: every wait that began, even one that ended at once; `off`: none. Parsed to
 * milliseconds, `0` for `always` and `null` for `off`.
 */
export const EVENT_WAIT_THRESHOLD_ALWAYS = 'always';
/** `telemetry.synchronous` (`PRAGMA synchronous` of the telemetry base only; the `Store` stays full). */
export const TELEMETRY_SYNCHRONOUS_MODES = ['normal', 'full'] as const;
/** `backup.telemetry`: whether the backup carries the telemetry file. */
export const BACKUP_TELEMETRY_MODES = ['exclude', 'include'] as const;

/** `telemetry.redaction`: `default` also redacts the content (prompts, answers, tool arguments and output); `full` keeps it. */
export const TELEMETRY_REDACTION_MODES = ['default', 'full'] as const;

/** `telemetry.receiver.reparent` (Phase 9, P1; [proposta]): `session` puts the clients' spans under the daemon's tree; `off` keeps them in their own traces. */
export const TELEMETRY_REPARENT_MODES = ['session', 'off'] as const;
export type TelemetryReparentMode = (typeof TELEMETRY_REPARENT_MODES)[number];

const TelemetrySwitch = z.enum(TELEMETRY_SWITCH_MODES);

/**
 * One entry of `telemetry.clients.<client>`: `on` or `off` (shorthand for `enabled`), or an object
 * with `enabled` and the options of that client. After parsing it is always the object. [proposta]
 */
function telemetryClient<Shape extends z.ZodRawShape>(options: Shape) {
  return z
    .preprocess(
      (value) => (typeof value === 'string' ? { enabled: value } : value),
      z.strictObject({ enabled: TelemetrySwitch.default('on'), ...options }),
    )
    .prefault({});
}

/**
 * `telemetry.otlp` (Phase 8, P7; N70, N211): where the daemon sends what the telemetry base holds
 * when `telemetry.export` is `otlp` or `both`. `endpoint`, `protocol` and `headers` are the keys of
 * the architecture (5.11); the rest is [proposta].
 * - `endpoint`: the base URL of an OTLP/HTTP receiver; the exporter posts to `/v1/traces`,
 *   `/v1/metrics` and `/v1/logs` under it. `null` is only valid while the export is not OTLP.
 * - `protocol`: `http/json` (N211, code of our own). `http/protobuf` and `grpc` are future modes and
 *   the config refuses them with that message, so no value parses and then does nothing.
 * - `headers`: header name to the **key of a secret in the vault**; the value is read when a request
 *   is sent and never kept in the config, the log or an event. Over `http://` to a host that is not
 *   loopback, headers are refused (they would cross the network in clear text).
 * - `compression`: `none` or `gzip`; `timeout`: per request; `interval`: how often the exporter
 *   looks for what is new; `batch`: records per request (per signal);
 *   `signals.<signal>`: `on` or `off` for traces, metrics and logs.
 * - `retry`: after a failed request it tries again `retries` times, waiting `initial` and then, with
 *   `backoff: exponential`, double each time up to `max` (`fixed` waits `initial` every time).
 * - `on_failure`: `drop` (default) or `hold`, see {@link TELEMETRY_EXPORT_FAILURE_MODES};
 *   `failure_report`: the window in which the failures are told once, in `telemetry.export_failed`.
 */
const TelemetryOtlpConfigSchema = z
  .strictObject({
    endpoint: z
      .url({ protocol: /^https?$/u, message: 'expected an http or https URL' })
      .nullable()
      .default(null),
    protocol: z
      .enum(TELEMETRY_OTLP_PROTOCOLS)
      .refine((protocol) => SUPPORTED_OTLP_PROTOCOLS.includes(protocol), {
        message:
          'only http/json exists for now; http/protobuf and grpc are future modes of telemetry.otlp.protocol (N211)',
      })
      .default('http/json'),
    headers: z
      .record(
        z.string().regex(HEADER_NAME_PATTERN, 'expected an HTTP header name'),
        SecretKeySchema,
      )
      .default({}),
    compression: z.enum(TELEMETRY_OTLP_COMPRESSIONS).default('none'),
    timeout: DurationSchema.prefault('10s'),
    interval: DurationSchema.prefault('10s'),
    batch: z.int().min(1).max(10_000).default(500),
    signals: z
      .strictObject({
        traces: TelemetrySwitch.default('on'),
        metrics: TelemetrySwitch.default('on'),
        logs: TelemetrySwitch.default('on'),
      })
      .prefault({}),
    retry: z
      .strictObject({
        retries: z.int().min(0).max(10).default(3),
        backoff: z.enum(TELEMETRY_RETRY_BACKOFFS).default('exponential'),
        initial: DurationSchema.prefault('1s'),
        max: DurationSchema.prefault('30s'),
      })
      .prefault({}),
    on_failure: z.enum(TELEMETRY_EXPORT_FAILURE_MODES).default('drop'),
    failure_report: DurationSchema.prefault('1m'),
  })
  .prefault({});

/**
 * `telemetry.prometheus` (P7; N218): `cache_ttl` is how long `GET /metrics` reuses what it
 * computed from the usage records, so a scrape every few seconds does not read the table each time.
 * [proposta]
 */
const TelemetryPrometheusConfigSchema = z
  .strictObject({ cache_ttl: DurationSchema.prefault('5s') })
  .prefault({});

/** True for a host that is this machine: the only one `http://` may reach with headers. */
function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '[::1]' ||
    /^127\.\d+\.\d+\.\d+$/u.test(hostname)
  );
}

/**
 * `telemetry.retention` (Phase 8, P8; N216 (a)): how long the raw telemetry stays in the telemetry
 * base, and how big the base may get. The store and its event log are not touched (N216 (a)), and
 * the daily aggregates keep their own retention (`analysis.retention.days`). [proposta] Names and
 * modes, except `days` (30) and `max_mb` (1024), which are in the plan.
 *
 * - `mode` (default `daily`): when the purge runs, see {@link TELEMETRY_RETENTION_MODES}.
 * - `interval` (default `24h`): the time between two passes of `daily`.
 * - `days` (default 30): records older than this go; `0` keeps them whatever their age.
 * - `max_mb` (default 1024): the data in the base may not pass this size; the oldest go first;
 *   `0` sets no cap. A base that stays over it is compacted (the file is rewritten) so the disk
 *   is really freed.
 * - `guard` (default `rollups`): see {@link TELEMETRY_RETENTION_GUARDS}.
 */
const TelemetryRetentionSchema = z
  .strictObject({
    mode: z.enum(TELEMETRY_RETENTION_MODES).default('daily'),
    interval: DurationSchema.prefault('24h'),
    days: z.int().min(0).max(36_500).default(30),
    max_mb: z.int().min(0).max(1_048_576).default(1024),
    guard: z.enum(TELEMETRY_RETENTION_GUARDS).default('rollups'),
  })
  .prefault({});

/**
 * The telemetry of the clients (architecture 5.11, N54; Phase 8, P1). Owns the whole block; P2 added
 * `receiver.*` and `redaction` after these keys. Every key is [proposta] except where the plan names it.
 */
const TelemetryConfigSchema = z
  .strictObject({
    /** `off`: no telemetry base is opened and nothing is received or kept. */
    enabled: TelemetrySwitch.default('on'),
    /** The telemetry base, in the data folder (or absolute). Apart from `store.sqlite` (N54). */
    file: z.string().min(1).default('telemetry.sqlite'),
    /** `normal` (default): a power cut may lose the last commits, never corrupts. */
    synchronous: z.enum(TELEMETRY_SYNCHRONOUS_MODES).default('normal'),
    write: z
      .strictObject({
        /** Records per transaction; a queue that reaches it is written at once. */
        batch: z.int().min(1).max(100_000).default(500),
        /** Records the queue holds; when full the oldest are dropped and counted. */
        queue_max: z.int().min(1).max(10_000_000).default(20_000),
        /** A queue that did not fill up is written after this long. */
        flush_interval: DurationSchema.prefault('1s'),
        /** With no base, how long to wait before trying to open it again. */
        retry_after: DurationSchema.prefault('1m'),
      })
      .prefault({}),
    /**
     * Which clients send telemetry to the daemon (P3 turns them on at launch). Each accepts `on` or
     * `off`, or an object with `enabled` and its options:
     * - `claude-code.traces`: also ask for the traces (beta); default `off`;
     * - `claude-code.metrics_interval`: how often Claude Code exports its metrics, a duration
     *   (default `5s`) or `client` (its own default, 60 s). A session ends with a SIGTERM, so what
     *   was not exported by then is lost; with 60 s a short session sends no metric. [proposta]
     * - `opencode.ai_spans`: `experimental.openTelemetry` for the AI spans (N213); default `off`.
     */
    clients: z
      .strictObject({
        'claude-code': telemetryClient({
          traces: TelemetrySwitch.default('off'),
          metrics_interval: z.union([z.literal('client'), DurationSchema]).prefault('5s'),
        }),
        codex: telemetryClient({}),
        opencode: telemetryClient({ ai_spans: TelemetrySwitch.default('off') }),
      })
      .prefault({}),
    /**
     * The OTLP/HTTP receiver of the daemon (P2, N211 to N213), loopback only, JSON only. [proposta]
     * - `port`: `auto` (a free port, each boot) or a fixed one;
     * - `max_body`: the largest body (after gunzip) a batch may have; a larger one is a 413;
     * - `reparent` (Phase 9, P1, N230 (2); [proposta]): `session` (default) puts the spans of a
     *   client under the span of their session (or attempt) in the daemon's trace, so there is one
     *   tree; the trace and the parent the client used stay in `otheater.client.trace_id` and
     *   `otheater.client.parent_span_id`. A span of a session the daemon does not know is left as it
     *   came. `off`: every span stays in the trace of its client, tied by attribute only. It hangs
     *   from the spans of `telemetry.daemon_spans`: with those `off` there is no parent to find.
     */
    receiver: z
      .strictObject({
        port: z.union([z.literal('auto'), z.int().min(1024).max(65535)]).default('auto'),
        max_body: SizeSchema.refine((bytes) => bytes > 0, 'expected a size above zero').prefault(
          '8MB',
        ),
        reparent: z.enum(TELEMETRY_REPARENT_MODES).default('session'),
      })
      .prefault({}),
    /**
     * What the receiver keeps of the content (P2, N212). `default`: the identity and secrets are
     * always removed, and so is the content (prompts, answers, tool arguments and output), kept as
     * size and hash. `full`: the content stays; the identity and secrets are still removed.
     */
    redaction: z.enum(TELEMETRY_REDACTION_MODES).default('default'),
    /**
     * The spans of the daemon itself (P4; N214 (a)): the play, its stages, the attempts, the
     * sessions, the tool calls and the waits, made by reading the event log with a cursor of their
     * own. `on` or `off`, or an object with `enabled` and `waits` ({@link TELEMETRY_DAEMON_WAITS_MODES}).
     * Default `on`. [proposta]
     */
    daemon_spans: telemetryClient({ waits: z.enum(TELEMETRY_DAEMON_WAITS_MODES).default('all') }),
    /**
     * What leaves the daemon (P7, N70): `off` (default: nothing leaves, `/metrics` answers 404),
     * `otlp` (the exporter of `telemetry.otlp`), `prometheus` (`GET /metrics`) or `both`.
     */
    export: z.enum(TELEMETRY_EXPORT_MODES).default('off'),
    otlp: TelemetryOtlpConfigSchema,
    prometheus: TelemetryPrometheusConfigSchema,
    /** How long the raw telemetry stays and how big the base may get (P8, N216 (a)). */
    retention: TelemetryRetentionSchema,
  })
  .superRefine((telemetry, ctx) => {
    const { endpoint, headers } = telemetry.otlp;
    if (exportsOtlp(telemetry.export) && endpoint === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['otlp', 'endpoint'],
        message: 'telemetry.otlp.endpoint is required when telemetry.export is otlp or both',
      });
    }
    // The exporter reads the telemetry base: with telemetry off there is nothing to send [proposta].
    if (exportsOtlp(telemetry.export) && telemetry.enabled === 'off') {
      ctx.addIssue({
        code: 'custom',
        path: ['export'],
        message:
          'telemetry.export otlp or both needs telemetry.enabled on: the exporter reads the telemetry base',
      });
    }
    if (
      endpoint !== null &&
      Object.keys(headers).length > 0 &&
      new URL(endpoint).protocol === 'http:' &&
      !isLoopbackHost(new URL(endpoint).hostname)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['otlp', 'headers'],
        message:
          'telemetry.otlp.headers over http:// to a host that is not this machine would cross the network in clear text; use https://',
      });
    }
  })
  .prefault({});

/**
 * `<data>/config.yaml` (architecture 5.18 and 5.21; decision N51 for the retention keys). Every
 * section is optional and every key has a default, so a missing file means the defaults. Strict at
 * every level: a misspelled key is an error that names its path, not a silent default.
 *
 * Durations are written as text and held as milliseconds after parsing (`backup.idle`).
 */
export const DaemonConfigSchema = z
  .strictObject({
    adapters: z
      .strictObject({
        store: z.enum(STORE_ADAPTER_IDS).default('sqlite'),
        vault: z.enum(VAULT_ADAPTER_IDS).default('keyring'),
        clock: z.enum(CLOCK_ADAPTER_IDS).default('system'),
        prompts: z.enum(PROMPT_ADAPTER_IDS).default('files'),
      })
      .prefault({}),
    /** `SqliteStoreConfigSchema` without `path` (the path is `<data>/store.sqlite`). */
    store: AdapterSection.prefault({}),
    /** Config of the chosen vault adapter (keyring: service, linuxStore; encrypted-file: path, scrypt). */
    vault: AdapterSection.prefault({}),
    /**
     * Config of the chosen prompt source (files: `directory`, a folder with one `<role>.md` per role;
     * without it the versioned `prompts/` folder of the repository is used). [proposta]
     */
    prompts: AdapterSection.prefault({}),
    /** The telemetry of the clients and its own base (architecture 5.11, N54). */
    telemetry: TelemetryConfigSchema,
    backup: z
      .strictObject({
        when: z.enum(BACKUP_WHEN).default('daily_after'),
        after: TimeOfDaySchema.default('03:00'),
        idle: DurationSchema.prefault('30m'),
        /** Relative to the data directory, or absolute. */
        dir: z.string().min(1).default('backups'),
        retention: z.enum(BACKUP_RETENTION).default('days'),
        keep_days: z.number().positive().default(2),
        copies: z.int().min(1).default(7),
        content: z.enum(BACKUP_CONTENTS).default('without_runs'),
        /**
         * `exclude` (default): the telemetry file is left out of the backup (it is a mirror that is
         * cheap to lose, and it grows). `include`: a consistent copy goes in as `telemetry.sqlite`. [proposta]
         */
        telemetry: z.enum(BACKUP_TELEMETRY_MODES).default('exclude'),
        method: z.enum(BACKUP_METHOD_NAMES).default('online_api'),
        /**
         * `online_api` only (ignored with `vacuum_into`): pages copied per `sqlite3_backup_step`.
         * `all` copies everything in one step. WARNING: a number >= 1 lets the event loop breathe
         * between steps, but SQLite restarts the copy at every commit, so with a writer active in
         * the same process steps of 100 or 1000 pages timed out (`Transient`) in 21 of 24 runs.
         */
        pages_per_step: PagesPerStepSchema.default('all'),
      })
      .prefault({}),
    /**
     * Pools of Executor processes per `(client, profile)` (architecture 5.2). `sessions_per_process`
     * is the `K` of the text and `idle` its `idleMs`; the other keys are [proposta]. Each client has
     * a section of its own (`pool.claude-code`, `pool.codex`, `pool.opencode`); a key absent there
     * inherits the global one, except `sessions_per_process` of Codex (6) and OpenCode (4), which
     * have their own defaults (N74, owner's decision after a real measurement, 2026-11-16).
     */
    pool: z
      .strictObject({
        /**
         * `K`: sessions per adapter process, for the clients that share one (`multi-session`). Only
         * applies to a client with no default of its own (today Claude Code, which is
         * `process-per-session`, so `K` changes nothing there); Codex and OpenCode have theirs (N74).
         */
        sessions_per_process: z.int().min(1).default(4),
        /** Admission semaphore: sessions running at once, counted per session and not per process. */
        max_sessions: z.int().min(1).default(4),
        /** A process with no session for this long is closed (`idleMs`). */
        idle: DurationSchema.prefault('2m'),
        /**
         * N64: what cancelling a session does to a process that runs other sessions too. `escalate`
         * ends the process only when the client did not honour `session/cancel` within the grace;
         * `always_kill` ends it on every cancel; `release` only gives the slot back.
         */
        shared_cancel: z.enum(SHARED_CANCEL_MODES).default('escalate'),
        /**
         * The admission of sessions (architecture 5.9, P4). `mode`: `slots` (default, the behaviour
         * before P4: only `max_sessions` and the slots of a local instance), `ram` (also the free RAM)
         * or `ram_and_quota` (also the quota hook). Every key here is [proposta]; the default mode
         * is `slots` so that nothing changes until the owner chooses another (see N118 to N129).
         */
        admission: z
          .strictObject({
            mode: z.enum(ADMISSION_MODES).default(DEFAULT_ADMISSION.mode),
            /** RAM that must stay free after a session is admitted. */
            min_free_mb: z.int().min(0).default(DEFAULT_ADMISSION.minFreeMb),
            /** How often a waiting session looks again at RAM and quota. */
            recheck: DurationSchema.prefault('5s'),
            /** What a machine that cannot tell its free RAM means: `admit` (as `slots`) or `wait`. */
            unknown_ram: z.enum(UNKNOWN_RAM_MODES).default(DEFAULT_ADMISSION.unknownRam),
          })
          .prefault({}),
        /** `K` of Claude Code alone; no default of its own (inherits the global key, 4). */
        'claude-code': PoolClaudeCodeSchema.prefault({}),
        /** `K` of Codex alone; default 6 (N74, real measurement of 2026-11-16). */
        codex: PoolCodexSchema.prefault({}),
        /**
         * N56 (5.2): how OpenCode shares its processes (the adapter wiring reads `process_model`; the
         * pool follows the adapter's `processModel`), and `K` of OpenCode alone (default 4, explicit:
         * N74, real measurement of 2026-11-16).
         */
        opencode: PoolClientSchema.extend({
          sessions_per_process: z.int().min(1).default(4),
          session_mb: SessionMbSchema.default(DEFAULT_SESSION_MB.opencode),
          process_model: z.enum(OPENCODE_PROCESS_MODELS).default('per_profile'),
        }).prefault({}),
      })
      .prefault({}),
    /**
     * The framework MCP server (architecture 5.3), Streamable HTTP on 127.0.0.1 only. `port: auto`
     * (N81, owner's decision) takes a free port at every start and the real URL is given to the
     * sessions; a number (1024 to 65535) fixes it.
     */
    mcp: z
      .strictObject({
        port: z.union([z.literal('auto'), z.int().min(1024).max(65535)]).default('auto'),
      })
      .prefault({}),
    /**
     * The processes of the plugins and the calls to them (architecture 5.14; Phase 9, P5). A plugin
     * is an MCP server that runs outside the daemon, one process per plugin and project (N238).
     * Every key here is [proposta]. (The keys of the registry and of the installation, `install.*`,
     * join this object with P4.)
     * - `idle_timeout`: how long a process with no call lives; `off` keeps it until the daemon stops.
     * - `max_restarts`: failures in a row (a start that fails, or a process that dies) after which
     *   the process stays stopped until the Producer starts it again; `0` stops it at the first one.
     * - `call_timeout`: the deadline of one call to a tool of a plugin; past it the call ends with a
     *   tool error and the request is cancelled in the server.
     * - `start_timeout`: how long the start of a process (spawn, handshake and `tools/list`) may take.
     * - `restart_backoff`: the wait before a process that failed is started again, doubling from
     *   `initial` up to `max`.
     * - `http`: `loopback` (default) lets a manifest with `server.type: http` connect to its
     *   address, which the manifest already confines to the loopback, with no authentication;
     *   `off` refuses those plugins (only `stdio` runs).
     */
    plugins: z
      .strictObject({
        idle_timeout: OffOrDurationSchema.prefault('10m'),
        max_restarts: z.int().min(0).max(100).default(3),
        call_timeout: DurationSchema.prefault('60s'),
        start_timeout: DurationSchema.prefault('30s'),
        restart_backoff: z
          .strictObject({
            initial: DurationSchema.prefault('1s'),
            max: DurationSchema.prefault('1m'),
          })
          .prefault({}),
        http: z.enum(['loopback', 'off']).default('loopback'),
      })
      .prefault({}),
    /**
     * The single prompt queue of the Director (architecture 5.4; P7). `order`: `producer_first`
     * (default) delivers the Producer's message ahead of the notices of the daemon, `fifo` delivers
     * by arrival only. `summary_messages` is how many of the last messages the state summary lists
     * (a new Director session, or one waking up, reads it).
     */
    prompt_queue: z
      .strictObject({
        order: z.enum(PROMPT_ORDER_MODES).default('producer_first'),
        summary_messages: z.int().min(0).default(DEFAULT_SUMMARY_MESSAGES),
      })
      .prefault({}),
    /**
     * Limits of the pipeline (architecture 5.4). Resolved: the preset is already applied, and an
     * individual key overrides only its own value.
     */
    limits: z
      .strictObject({
        preset: z.enum(LIMIT_PRESET_NAMES).default('moderate'),
        /** `Np`: plan rejections that go back to PLANNING; one more goes to the Producer. */
        plan_reviews: z.int().min(0).optional(),
        /** `Nc`: Critic rejections before the failure becomes structural. */
        critic_rejections: z.int().min(0).optional(),
        /** Attempts per demand, the first one included. */
        attempts_per_demand: z.int().min(1).optional(),
        script_validations: z.int().min(0).optional(),
        script_vetoes: z.int().min(0).optional(),
        script_returns: z.int().min(0).optional(),
        structural_restarts: z.int().min(0).optional(),
        /** Invalid `submit*` outputs handed back to the Executor before the failure (N79). */
        submit_retries: z.int().min(0).optional(),
        /** When the plan does not set `timeoutMin` for the demand. */
        demand_timeout: DurationSchema.optional(),
        /** Ceiling of what the plan may ask for. */
        demand_timeout_max: DurationSchema.optional(),
        /**
         * [proposta] (N184) How long one turn (one prompt of a session, from its start) may take,
         * never above `demand_timeout`. Absent: the preset (moderate 15m, economical 10m,
         * persistent 25m). What happens when it runs out is `on_turn_timeout`.
         */
        turn_timeout: DurationSchema.optional(),
        /** [proposta] (N184) `cancel` (default), `notice` or `off`; see `TURN_TIMEOUT_MODES`. */
        on_turn_timeout: z.enum(TURN_TIMEOUT_MODES).default('cancel'),
      })
      .prefault({})
      .refine(
        (limits) =>
          limits.turn_timeout === undefined ||
          limits.turn_timeout <=
            (limits.demand_timeout ?? LIMIT_PRESETS[limits.preset].demand_timeout),
        { message: 'turn_timeout must not exceed demand_timeout', path: ['turn_timeout'] },
      )
      .transform(resolveLimits)
      .refine((limits) => limits.demand_timeout <= limits.demand_timeout_max, {
        message: 'demand_timeout must not exceed demand_timeout_max',
        path: ['demand_timeout'],
      }),
    /** Pausing a play (architecture 5.12; N176, owner, 2026-11-20). */
    pause: z
      .strictObject({
        /** `drain` (default) or `interrupt`; see {@link PAUSE_MODES}. */
        mode: z.enum(PAUSE_MODES).default('drain'),
      })
      .prefault({}),
    /**
     * How a play runs (architecture 5.4; P8). [proposta] Until the executor catalog and the role
     * presets exist (`roles.preset`, 5.7), the Executor of each role is a key here:
     * - `executor`: the Executor every role without its own entry uses (`client` is the id of a
     *   client adapter, `profile` the name of a profile of it). Absent: a play cannot start its
     *   stages and says so (the daemon never picks an account for the user);
     * - `roles`: an Executor per role, which wins over `executor`;
     * - `verify`: `run` (default) runs the `verify` steps of a demand in its worktree when the
     *   attempt ends; `skip` takes them as passed (a test rig, or a project whose checks run in CI).
     */
    orchestration: z
      .strictObject({
        executor: PlayExecutorSchema.optional(),
        roles: z.record(z.string().min(1), PlayExecutorSchema).default({}),
        verify: z.enum(VERIFY_MODES).default('run'),
      })
      .prefault({}),
    /**
     * The tool policy of each role: `roles.<role>.policy` (architecture 5.2 and 5.8; Phase 4, P1,
     * N99). Absent: the default policy of the role. A project and a scenario override it through
     * their `configOverride`. See `role-policy-config.ts`.
     */
    roles: RolesConfigSchema.prefault({}),
    /**
     * The Executors and how they join the roles (architecture 5.7; Phase 5, P13): `executors.<id>`
     * (`<model>-<effort>@<client>/<profile>`), `cross_client` (`api_only` default | `off` | `any`)
     * and `on_register` (`ask` default | `preset_only` | `none`). The lists of the roles are under
     * `roles`. See `role-executors-config.ts`; the pipeline reads them from P16.
     */
    executors: ExecutorsConfigSchema.prefault({}),
    /**
     * How the daemon picks among the Executors of a role (architecture 5.7; Phase 5, P15):
     * `strategy` (`ordered` default | `most_headroom` | `round_robin`, N130), `cross_check`
     * (`prefer_other_provider` default | `require_other_provider` | `other_model` | `off`) and,
     * [proposta], `unknown_quota` (`allow` | `skip`), `near_limit` (`keep_order` | `last` | `skip`),
     * `retry_diversity` (`rotate` | `forward_only` | `off`) and `context_reserve`. See
     * `role-executors-config.ts`; the pipeline reads them from P16.
     */
    selection: SelectionConfigSchema.prefault({}),
    /**
     * The tier of a model, optional, on one scale for every provider: `models.<model>.tier`
     * (`small` | `medium` | `large` | `frontier`; N150). Feeds the "stronger model" step of
     * `selection.same_provider_fallback`. See `role-executors-config.ts`.
     */
    models: ModelsConfigSchema.prefault({}),
    /**
     * The chat of the Producer with the Director (architecture 5.3 and 5.4; N78, P8). `history` is
     * how many replies of the Director the channel keeps in memory per scenario. (The loopback
     * channel and its `channel` key are gone since P8 of docs/17: `ot chat` uses the API.)
     * `presence` and `presence_window` say when a play counts as watched (`delivery.base_drift: ask`).
     * `silent_turn` (N183) is what the chat gets when a turn of the Director ends without text.
     */
    chat: z
      .strictObject({
        history: z.int().min(1).default(200),
        /** [proposta] Who counts as watching a play: see {@link CHAT_PRESENCE_MODES}. */
        presence: z.enum(CHAT_PRESENCE_MODES).default('connected'),
        /** [proposta] How long after its last poll an `ot chat` still counts as present (`presence: connected`). */
        presence_window: DurationSchema.prefault('30s'),
        /** [proposta] A turn of the Director with no text: see {@link SILENT_TURN_MODES}. */
        silent_turn: z.enum(SILENT_TURN_MODES).default('notice'),
        /** [proposta: on] The `/` commands go to the registry of the daemon: see {@link SLASH_COMMAND_MODES}. */
        slash_commands: z.enum(SLASH_COMMAND_MODES).default('on'),
        /** [proposta: on] The commands of the client of the Director: see {@link CLIENT_COMMAND_MODES}. */
        client_commands: z.enum(CLIENT_COMMAND_MODES).default('on'),
        /**
         * [proposta] The commands `client_commands: allowlist` lets through, with the prefix
         * (`claude:compact`) or without the slash. (A key `client_commands.allow` is not possible:
         * `client_commands` is a value, and a YAML key cannot be a value and a map.)
         */
        client_commands_allow: z.array(z.string().min(1)).default([]),
        /** [proposta: always] A command that asks for a confirmation (`/cancel`): see {@link SLASH_CONFIRM_MODES}. */
        slash_confirm: z.enum(SLASH_CONFIRM_MODES).default('always'),
        /** [proposta: 20] How many events `/logs` shows when it is given no number. */
        slash_logs_lines: z.int().min(1).max(500).default(20),
        /** [proposta: full] What the `/` commands may do: see {@link SLASH_ACCESS_MODES}. */
        slash_access: z.enum(SLASH_ACCESS_MODES).default('full'),
        /**
         * [proposta] The templates for the Director: name (without the slash) to the text that
         * goes before what the Producer types. A name that is a command of the daemon is ignored.
         */
        slash_templates: z
          .record(z.string().regex(/^[a-z][a-z0-9_-]*$/), z.string().min(1))
          .default({ ...DEFAULT_SLASH_TEMPLATES }),
        /**
         * [proposta] The `!` command of the Producer (N43, N187): `on` | `off` or a section with
         * `mode`, `timeout` (a duration or `off`; default 5m) and `context` (`auto` | `ask` | `never`).
         * See `shell-config.ts`.
         */
        shell_command: ShellCommandConfigSchema,
      })
      .prefault({}),
    /** [proposta] Where the `!` command of the Producer runs (architecture 5.13): see `shell-config.ts`. */
    app: z
      .strictObject({
        terminal: z.enum(APP_TERMINAL_MODES).default('sandbox'),
      })
      .prefault({}),
    /** [proposta] The snippet and the log of a `!` command (architecture 5.19): see `shell-config.ts`. */
    terminal: TerminalConfigSchema,
    /** [proposta] The direct session with an Actor (architecture 5.20): see `direct/direct-config.ts`. */
    direct_session: DirectSessionConfigSchema,
    /** [proposta] The ATIF export of the trajectories (architecture 5.11, N219): see `atif/atif-config.ts`. */
    atif: AtifConfigSchema,
    /** [proposta] The analysis of the system (architecture 5.11, N55 and N217): see `analysis/analysis-config.ts`. */
    analysis: AnalysisConfigSchema,
    /** What the start-up does after a crash or a restart (architecture 5.21). */
    recovery: z
      .strictObject({
        notice: z.enum(RECOVERY_NOTICE_MODES).default('always'),
      })
      .prefault({}),
    /** Retries and checkpoints (architecture 5.16). Resolved: the preset is already applied. */
    resume: z
      .strictObject({
        preset: z.enum(RESUME_PRESET_NAMES).default('balanced'),
        max_resumes: z.int().min(0).optional(),
        /**
         * [proposta] Resumes of a session that fell with another session's cancel
         * (`pool.shared_cancel`) that do not count in `max_resumes`, per attempt. Past this many, the
         * resume counts like any other drop. `0`: none is free. Decided by the owner, 2026-11-16.
         */
        max_free_resumes: z.int().min(0).optional(),
        quota_wait_max: DurationSchema.optional(),
        checkpoint_every: DurationSchema.optional(),
        /** [proposta] Completed edit tool calls that make one batch (a checkpoint follows each batch). */
        checkpoint_edit_batch: z.int().min(1).default(3),
        stuck: z
          .strictObject({
            no_event_for: DurationSchema.optional(),
            same_error_times: z.int().min(1).optional(),
          })
          .prefault({}),
        transient_backoff: z.array(DurationSchema).prefault(['30s', '2m', '10m']),
        /**
         * [proposta] (P17) What follows the last step of `transient_backoff`: `last` keeps waiting
         * the last step until `max_resumes` (the behaviour before P17); `handoff` passes the baton
         * (the literal reading of architecture 5.16).
         */
        transient_exhausted: z.enum(['last', 'handoff']).default('last'),
        /**
         * [proposta] (P17) When a drop of the client process counts as an attempt of the demand:
         * `repeat` (5.16: not the first time, yes if it repeats), `never` or `always`.
         */
        client_crash_counts: z.enum(['repeat', 'never', 'always']).default('repeat'),
        /**
         * [proposta] (P19) How long after the reset the attempt keeps waiting for `quota.restored`
         * before it looks at the profile itself (a hook that was missed): then it resumes if the profile
         * is back and goes by `quota_wait_missed` if not.
         */
        quota_wait_grace: DurationSchema.prefault('1m'),
        /** [proposta] (P19) See {@link QUOTA_WAIT_DEADLINE_MODES}. */
        quota_wait_deadline: z.enum(QUOTA_WAIT_DEADLINE_MODES).default('pause'),
        /** [proposta] (P19) See {@link QUOTA_WAIT_COUNTS_MODES}. */
        quota_wait_counts: z.enum(QUOTA_WAIT_COUNTS_MODES).default('resume'),
        /** [proposta] (P19) See {@link QUOTA_WAIT_MISSED_MODES}. */
        quota_wait_missed: z.enum(QUOTA_WAIT_MISSED_MODES).default('handoff'),
        /** [proposta] (P21b, N152) See {@link ON_PROFILE_REMOVED_MODES}. */
        on_profile_removed: z.enum(ON_PROFILE_REMOVED_MODES).default('handoff'),
        /** [proposta] What the Executor is told when a conversation is reloaded. */
        continue_prompt: z
          .string()
          .min(1)
          .default('Continue the task from where you stopped. Do not start over.'),
        /** The continuation package of a handoff (architecture 5.16, Phase 5, P18). */
        package: z
          .strictObject({
            /** N126 (decided): see {@link PACKAGE_SUMMARIZE_MODES}. */
            summarize: z.enum(PACKAGE_SUMMARIZE_MODES).default('deterministic'),
            /**
             * [proposta] Largest size of the package text, in characters (about four per token).
             * Past it the package gives up detail in a fixed order (the diff text, then the long
             * lists); the demand, the orders and the instruction stay.
             */
            max_chars: z.int().min(2000).default(48_000),
            /** [proposta] How much of the diff goes in: see {@link PACKAGE_DIFF_MODES}. */
            diff: z.enum(PACKAGE_DIFF_MODES).default('stat'),
            /** [proposta] Largest size of the diff text, with `diff: full`. */
            diff_max_chars: z.int().min(0).default(12_000),
            /** [proposta] Roles of short output; see {@link PACKAGE_SHORT_OUTPUT_MODES}. */
            short_output_roles: z
              .array(z.enum(ROLE_IDS))
              .default(['reviewer', 'scriptwriter', 'critic']),
            /** [proposta] What the handoff does in those roles. */
            short_output: z.enum(PACKAGE_SHORT_OUTPUT_MODES).default('redo'),
          })
          .prefault({}),
      })
      .prefault({})
      .transform((resume) => {
        const preset = RESUME_PRESETS[resume.preset];
        return {
          preset: resume.preset,
          max_resumes: resume.max_resumes ?? preset.max_resumes,
          max_free_resumes: resume.max_free_resumes ?? preset.max_free_resumes,
          quota_wait_max: resume.quota_wait_max ?? preset.quota_wait_max,
          checkpoint_every: resume.checkpoint_every ?? preset.checkpoint_every,
          checkpoint_edit_batch: resume.checkpoint_edit_batch,
          stuck: {
            no_event_for: resume.stuck.no_event_for ?? preset.no_event_for,
            same_error_times: resume.stuck.same_error_times ?? preset.same_error_times,
          },
          transient_backoff: resume.transient_backoff,
          transient_exhausted: resume.transient_exhausted,
          client_crash_counts: resume.client_crash_counts,
          quota_wait_grace: resume.quota_wait_grace,
          quota_wait_deadline: resume.quota_wait_deadline,
          quota_wait_counts: resume.quota_wait_counts,
          quota_wait_missed: resume.quota_wait_missed,
          on_profile_removed: resume.on_profile_removed,
          continue_prompt: resume.continue_prompt,
          package: resume.package,
        };
      }),
    /**
     * The clients that run attempts (architecture 5.2). Each one is built from its section by the
     * product's `ClientFactory`, in `compose.ts`.
     */
    clients: z
      .strictObject({
        'claude-code': ClaudeCodeClientSchema.prefault({}),
        codex: CodexClientSchema.prefault({}),
        opencode: OpenCodeClientSchema.prefault({}),
      })
      .prefault({}),
    /**
     * `security` (architecture 5.2): how many layers must guarantee each field of a policy, and what
     * happens when they do not. `writeScope` and `network` are guaranteed only by layer 3 (the
     * Sandbox, `sandbox.mode`): where it does not run (`sandbox.mode: off`, Windows, a kernel that
     * forbids it) the defaults refuse sessions with those fields; `unenforced: warn` lets them run.
     */
    security: z
      .strictObject({
        min_layers: z
          .strictObject({
            default: z.int().min(0).default(1),
            nativeTools: z.int().min(0).optional(),
            nativeShell: z.int().min(0).optional(),
            mcpServers: z.int().min(0).optional(),
            mcpTools: z.int().min(0).optional(),
            onAsk: z.int().min(0).optional(),
            bypass: z.int().min(0).optional(),
            writeScope: z.int().min(0).optional(),
            network: z.int().min(0).optional(),
          })
          .prefault({}),
        unenforced: z.enum(UNENFORCED_MODES).default('refuse'),
        /**
         * [proposta] `allow` (default): the session opened only to read a client's model catalog
         * (no prompt, never runs a turn) is exempt from `unenforced`; `refuse`: it goes through the
         * same check as a work session. Decided by the owner, 2026-11-16.
         */
        catalog_probe: z.enum(CATALOG_PROBE_MODES).default('allow'),
        /**
         * [proposta] How the daemon logs the `catalog_probe_exempt` warning the adapters emit at
         * every catalog read: `once` (default) per client and adapter version in each run, `every`
         * or `off`. Other warnings are always logged. Decided by the owner, 2026-11-16 (N69).
         */
        catalog_probe_log: z.enum(CATALOG_PROBE_LOG_MODES).default('once'),
        conformance: z.enum(CONFORMANCE_MODES).default('on_version_change'),
        /**
         * The paths an Executor cannot READ (architecture 5.19): the defaults (`~/.ssh`, the profiles
         * of the clients, `<data>`, `.env`...) plus `add`, minus `remove`. One list for the Sandbox and
         * for `browser_open`; `browser.secret_paths` is an alias of it [proposta]. An entry is `~/...`,
         * `<data>/...`, an absolute path or a bare name (`.env`) that matches in any folder.
         */
        secret_paths: z
          .strictObject({
            add: z.array(z.string().min(1)).default([]),
            remove: z.array(z.string().min(1)).default([]),
          })
          .prefault({}),
      })
      .prefault({}),
    /**
     * Layer 3 of the permissions (architecture 5.8). [proposta] `mode`: `runtime` (default) where an
     * adapter exists (Linux, macOS), `off` otherwise or by choice. `extra_write_paths`: absolute
     * folders a confined client or command may write besides the worktree, its own profile folder and
     * the temporary folder (for example the git folder of the repository). `extra_domains`: domains a
     * confined client may reach besides the `network.allow` of the role and the ones of its provider.
     */
    sandbox: z
      .strictObject({
        mode: z.enum(SANDBOX_MODES).default('runtime'),
        extra_write_paths: z
          .array(z.string().min(1).startsWith('/', 'expected an absolute path'))
          .default([]),
        extra_domains: z.array(z.string().min(1)).default([]),
        /** [proposta, N115, N161] `auto` (default): `unix` on macOS, `proxy` elsewhere; `off`: no bridge. */
        mcp_bridge: z.enum(SANDBOX_MCP_BRIDGE_MODES).default('auto'),
      })
      .prefault({}),
    tools: ToolsConfigSchema,
    browser: BrowserConfigSchema,
    /**
     * The API of the daemon (architecture 5.12; Phase 6, P3 of docs/17). [proposta] The names and
     * the defaults below. The API always binds `127.0.0.1` and always asks for the token.
     */
    api: z
      .strictObject({
        /** `auto` (default): the system picks a free port (tests, several daemons); or a fixed port. */
        port: z.union([z.literal('auto'), z.int().min(1024).max(65535)]).default('auto'),
        /**
         * `persistent` (default): `api-token` in the data folder is reused across starts (a client
         * keeps working over a restart). `per_start`: a new token at each start.
         */
        token: z.enum(API_TOKEN_MODES).default('persistent'),
        /**
         * `off` (default): loopback only. `vpn` and `proxy` (N165, N166) come in Phase 12 and are
         * refused for now, so a typo or a copied config never opens the API beyond the machine.
         */
        remote: z
          .enum(API_REMOTE_MODES)
          .default('off')
          .refine((mode) => mode === 'off', {
            message:
              'api.remote vpn and proxy are not available yet (Phase 12); only off is accepted',
          }),
        cors: z
          .strictObject({
            /**
             * Origins (`https://app.example`, no path, no `*`) a browser page may call the API from.
             * Empty (default): no `Access-Control-Allow-*` header is ever sent.
             */
            origins: z
              .array(
                z.string().refine(isOriginText, {
                  message: 'expected an origin such as https://app.example (scheme, host, port)',
                }),
              )
              .default([]),
          })
          .prefault({}),
        /** [proposta: 1 MiB] The largest request body the API reads; a bigger one is `payload_too_large`. */
        max_body_bytes: z.int().min(1).default(1_048_576),
        rejection_events: z
          .strictObject({
            /**
             * [proposta: 10s] At most one `api.client_rejected` event per reason (`token`, `host`,
             * `origin`) in this window, so a scan cannot flood the log of events; the event counts
             * what it held back. Every rejection is still a line in the daemon log.
             */
            every: DurationSchema.prefault('10s'),
          })
          .prefault({}),
        sse: z
          .strictObject({
            /**
             * [proposta: 1000] Live events one subscriber of the event hub may leave unseen before it
             * stops counting them and catches up from the log (`daemon/src/events/event-hub.ts`).
             */
            buffer_events: z.int().min(1).default(1000),
            /**
             * [proposta: 15s] Period of the comment line (`: heartbeat`) an idle event stream writes,
             * so a proxy or a client can tell a live stream from a dead one. `0` turns it off.
             */
            heartbeat: DurationSchema.or(z.literal(0)).prefault('15s'),
            /** [proposta: 2s] The `retry:` field the stream opens with: how long a client waits to reconnect. */
            retry: DurationSchema.prefault('2s'),
            /**
             * [proposta: 32] Event streams open at once. Past it `GET /v1/events` answers 503
             * `unavailable` with `Retry-After`.
             */
            max_streams: z.int().min(1).default(32),
            lagged_events: z
              .strictObject({
                /**
                 * [proposta: 10s] At most one `api.stream_lagged` event per reason in this window,
                 * so a stuck client cannot flood the log; the event counts what it held back.
                 */
                every: DurationSchema.prefault('10s'),
              })
              .prefault({}),
          })
          .prefault({}),
        /**
         * [proposta: 24h] How long the daemon remembers the answer of a command that came with an
         * `Idempotency-Key` (P6 of docs/17): a repeat with the same key and the same body inside
         * the window gets the first answer back and does not act again. `0` keeps nothing, so no
         * command is deduplicated. The memory is the daemon's own and does not survive a restart.
         */
        idempotency_ttl: DurationSchema.or(z.literal(0)).prefault('24h'),
        chat: z
          .strictObject({
            /** [proposta: 30s] How long a chat ticket (`POST /v1/chat-tickets`) is good for, and no longer. */
            ticket_ttl: DurationSchema.prefault('30s'),
            /**
             * [proposta: 30s] Interval of the protocol ping of the chat socket; a socket that did not
             * answer the previous ping with a pong by the next one is closed (`no_pong`).
             */
            heartbeat: DurationSchema.prefault('30s'),
            /** [proposta: 2s] After the daemon sends a close frame, how long it waits for the client before it ends the socket. */
            close_grace: DurationSchema.prefault('2s'),
            /** [proposta: 1 MiB] The largest message the chat socket takes from the client; a bigger one ends the socket (code 1009). */
            max_message_bytes: z.int().min(1).default(1_048_576),
            /**
             * [proposta: 60] Pongs the daemon may owe a client that floods it with pings (`maxPendingAutoPongs`
             * of `ws` 8.23.0, which ends the socket past it).
             */
            max_pending_pongs: z.int().min(1).default(60),
            /**
             * [proposta: 1s] How often the chat socket looks at what is not an event (`waits` and
             * `busy` come from the state of the scenario, not from the log) and sends it if it changed.
             */
            state_interval: DurationSchema.prefault('1s'),
            /**
             * [proposta: 250ms] How long the socket waits, after it opens, for the first message of the
             * client before it starts sending: a client with a cursor says `resume` first, and what the
             * daemon sent before that would come twice. A client with no cursor gets the current state
             * after this wait.
             */
            resume_window: DurationSchema.prefault('250ms'),
          })
          .prefault({}),
      })
      .prefault({}),
    events: z
      .strictObject({
        /** N80: `reject` (default) refuses an unknown type or an invalid payload; `warn` stores it and logs. */
        unknown_type: z.enum(EVENT_UNKNOWN_TYPE_MODES).default('reject'),
        /**
         * P11 of Phase 8 (N200 item 3) [proposta]: the live output of the terminal of the Actor.
         * `truncated` (default) writes `terminal.output` events up to `terminal_output_max` of each
         * terminal and marks the cut; `on` writes all of it; `off` writes none and the client is not
         * asked to send it (`_meta.terminal_output_delta` is left out of `initialize`). The shapes of a
         * credential are masked in every mode.
         */
        terminal_output: z.enum(TERMINAL_OUTPUT_MODES).default('truncated'),
        /** P11 [proposta]: the most output of one terminal that `terminal_output: truncated` keeps. */
        terminal_output_max: SizeSchema.refine(
          (bytes) => bytes > 0,
          'expected a size above zero',
        ).prefault('64KB'),
        /**
         * P15 of Phase 8 (N222 (a)) [proposta]: a wait of the prompt queue or of the session pool that
         * lasts this long is written as `wait.started` and `wait.ended` (the spans `otheater.wait` are
         * made from them). `always` writes every wait that began; `off` writes none.
         */
        wait_threshold: z
          .union([
            z.literal('off').transform(() => null),
            z.literal(EVENT_WAIT_THRESHOLD_ALWAYS).transform(() => 0),
            DurationSchema,
          ])
          .prefault('1s'),
      })
      .prefault({}),
    /**
     * Orders of the Producer (architecture 5.17). [proposta] Names and modes: `timezone` is the zone
     * a validity is read in when the order does not say one (architecture default
     * `America/Sao_Paulo`); `expiring_notice` is how long before the end the `directive.expiring`
     * notice is written (architecture default 24 hours; `0` turns the notice off).
     */
    directives: z
      .strictObject({
        timezone: z
          .string()
          .min(1)
          .refine(isKnownTimezone, 'expected an IANA time zone such as America/Sao_Paulo')
          .default(DEFAULT_DIRECTIVE_TIMEZONE),
        expiring_notice: DurationSchema.or(z.literal(0)).prefault('24h'),
      })
      .prefault({}),
    /**
     * Scenarios and the `chat` flow (architecture 5.20). `director_idle_after` is how long a Director
     * stays idle before it sleeps (architecture default 15 minutes; `0` = never sleeps).
     * `attachment_max_size` is the limit of an attachment copied into the data directory
     * (architecture default 50 MB; `0` = no limit; a reference to a file is not copied, so it is not
     * limited). [proposta] `attachment_read_max` is how much of an attachment `read_attachment`
     * returns in one call; `consultant_alternatives` are the Executors tried after the consultant's
     * own when the first cannot take the attachments (an image needs a client that accepts images).
     * [proposta] `consultant_writes` (P10, N86) is what becomes of the files the consultant wrote in
     * its worktree of the chat folder: `merge` (default) puts them in the folder, after the check
     * that each stays inside it; `keep` leaves them on a branch `play/<scenario>/attempts/consult-<n>/1` for
     * the Producer to read; `discard` drops them (the consultant only answers).
     * [proposta] `director_failover` (P20) is what the daemon does when the session of the
     * Director fails: `next` (default) opens a new session with the next Executor of the `director`
     * role when the cause is a quota or a spending cap (`quota_exhausted`, `spend_cap`), a provider
     * error or a drop (`transient`, `client_crash`); `quota_only` does it for the first two causes
     * only; `off` keeps the old behaviour (the queue stops until the next prompt tries again).
     * [proposta] `director_switch.in_turn` (P14, N242) is what a manual switch of the Director
     * (`/director`, the TUI footer) does when the Director is in a turn: `wait` (default) or `interrupt`.
     */
    scenarios: z
      .strictObject({
        director_idle_after: DurationSchema.or(z.literal(0)).prefault('15m'),
        attachment_max_size: SizeSchema.or(z.literal(0)).prefault('50MB'),
        attachment_read_max: SizeSchema.prefault('8MB'),
        consultant_alternatives: z.array(PlayExecutorSchema).default([]),
        consultant_writes: z.enum(['merge', 'keep', 'discard']).prefault('merge'),
        director_failover: z.enum(DIRECTOR_FAILOVER_MODES).prefault('next'),
        director_switch: z
          .strictObject({
            in_turn: z.enum(DIRECTOR_SWITCH_IN_TURN_MODES).prefault('wait'),
          })
          .prefault({}),
      })
      .prefault({}),
    /**
     * The idea queue of the scenario (architecture 5.20, N91): `drain` (`auto`, `manual`; `scheduled`
     * is refused until the scheduler exists), `grouping_approval` (`ask`, `auto`), `max_per_play`
     * and `parallel_plays`. A scenario overrides each key with `configOverride` (`ideas.drain`...).
     */
    ideas: IdeasConfigSchema.prefault({}),
    /**
     * Delivery policy (architecture 5.5, owner's decision N5). `mode` is the global value; the
     * override per project, play and scheduled task is the rule registry's `delivery.mode`.
     * `allow_direct_merge` is the project's permission: without it `direct_merge` and `ask` become
     * `pr`. Default: open the PR and stop.
     */
    delivery: z
      .strictObject({
        mode: z.enum(DELIVERY_MODES).default('pr'),
        allow_direct_merge: z.boolean().default(false),
        base_drift: z.enum(BASE_DRIFT_MODES).default('update'),
        changelog: z.enum(CHANGELOG_MODES).default('always'),
        /**
         * [proposta] The question of `mode: ask` (N89, P9). `timeout`: how long the Producer has to
         * answer (`10m`); `0` waits with no limit. When it runs out, the play goes on with the PR.
         * `on_leave`: see {@link DELIVERY_ASK_LEAVE_MODES}.
         */
        ask: z
          .strictObject({
            timeout: z.union([z.literal(0), DurationSchema]).prefault('10m'),
            on_leave: z.enum(DELIVERY_ASK_LEAVE_MODES).default('pr'),
          })
          .prefault({}),
      })
      .prefault({}),
    /**
     * Projects (architecture 5.20, profile `software`; P7). `conventions` is what happens to the
     * conventions of an imported repository: see {@link CONVENTIONS_MODES}.
     */
    project: z
      .strictObject({
        conventions: z.enum(CONVENTIONS_MODES).default('ask'),
      })
      .prefault({}),
    /** Integration of the demands (architecture 5.5): the rebase of the dependents (N82). */
    integration: z
      .strictObject({
        rebase_conflict: z.enum(REBASE_CONFLICT_MODES).default('redo'),
      })
      .prefault({}),
    /** A new script of a play that already did some work (architecture 5.5, N84). */
    rescript: z
      .strictObject({
        reuse: z.enum(RESCRIPT_REUSE_MODES).default('keep_unchanged'),
      })
      .prefault({}),
    /**
     * Profiles (architecture 5.6; Phase 5, P2). The drain defaults follow N127, decided by the
     * owner on 2026-11-18; `same_provider_notice` and `api_key_env` are [proposta];
     * `rotate_on_exhaustion` is N157 (owner, 2026-11-18; P26). Any other key is
     * a profile (`opencode/local`) with its block: `budget`, the spending cap of an API profile
     * (P11, see `budget-config.ts`), and `local`, the local model server of 5.9, which the cadastro
     * of an OpenCode Executor with a local model writes (P14).
     */
    profiles: withProfileEntries(
      z.strictObject({
        same_provider_notice: z.enum(SAME_PROVIDER_NOTICE_MODES).default('once'),
        drain: z
          .strictObject({
            /** How long a drain waits for the running sessions before `on_timeout` applies. */
            timeout: DurationSchema.or(z.literal(0)).prefault('10m'),
            on_timeout: z.enum(DRAIN_ON_TIMEOUT_MODES).default('handoff'),
            removed_dir: z.enum(REMOVED_DIR_MODES).default('delete'),
            /** [proposta] (P21b, N153) See {@link DRAIN_DIRECTOR_MODES}. */
            director: z.enum(DRAIN_DIRECTOR_MODES).default('failover'),
          })
          .prefault({}),
        /**
         * The environment variable that carries the API key of a provider into the Executor process
         * of an API profile, by provider id. A provider not listed uses its built-in name
         * (`anthropic` -> `ANTHROPIC_API_KEY`, `openai` -> `OPENAI_API_KEY`, `minimax` ->
         * `MINIMAX_API_KEY`, anything else `<PROVIDER>_API_KEY`).
         */
        api_key_env: z
          .record(z.string().min(1), z.string().regex(ENV_NAME, 'expected a variable name'))
          .default({}),
        /**
         * N157 (owner, 2026-11-18; P26): whether a subscription profile of a provider that ran out
         * passes the work to another subscription account of the same provider, by provider id
         * (`off` | `on`). With `off`, the selection (P15), the baton (P18) and the failover of the
         * Director (P20) wait for the reset or go to another provider; with `on`, the work rotates
         * and a `daemon.notice` `account_rotated` says so. Default `openai: off` (the terms of
         * OpenAI forbid rotating accounts to dodge the limits; risk R21), every other provider
         * `on`. API profiles and the spending cap are outside the rule.
         */
        rotate_on_exhaustion: z
          .record(z.string().min(1), z.enum(ROTATE_ON_EXHAUSTION_MODES))
          .transform((modes) => ({
            ...DEFAULT_ROTATE_ON_EXHAUSTION,
            ...Object.fromEntries(
              Object.entries(modes).map(([provider, mode]) => [provider.toLowerCase(), mode]),
            ),
          }))
          .prefault({}),
        /**
         * The common commands and options of `ot profile exec` and of the commands by profile
         * (P28a, N159; owner, 2026-11-19), added or rewritten by client: `commands.<name>.<client>`
         * and `options.<name>.<client>` are the tokens of that client (`commands.review.codex:
         * [review]`). The built-in ones are `login`, `logout`, `status`, `run` and `--model`; a
         * name configured here is common for every client, and one that has no tokens for it is
         * refused there. An option takes one value, which goes after its tokens.
         */
        commands: commonWordsSchema(0),
        options: commonWordsSchema(1),
        /** `ot profile exec` (P28a). See {@link PROFILE_EXEC_ENV_INHERIT_MODES}. */
        exec: z
          .strictObject({
            env_inherit: z.enum(PROFILE_EXEC_ENV_INHERIT_MODES).default('terminal'),
          })
          .prefault({}),
        /**
         * The commands by profile (P28b, N159; owner, 2026-11-19): `<prefix><client>-<profile>` in
         * `<data>/bin`. A name some other program already has in `PATH` is not created (warning
         * `shim_conflict`). See {@link PROFILE_SHIMS_MODES}.
         */
        shims: z
          .strictObject({
            prefix: z
              .string()
              .max(32)
              .regex(SHIM_PREFIX, 'expected letters, digits, ., _ or -')
              .default(''),
            mode: z.enum(PROFILE_SHIMS_MODES).default('auto'),
          })
          .prefault({}),
      }),
      [
        'same_provider_notice',
        'drain',
        'api_key_env',
        'rotate_on_exhaustion',
        'commands',
        'options',
        'exec',
        'shims',
      ],
    ).prefault({}),
    /**
     * The spending cap, for every profile and Executor that has one (architecture 5.6; P11).
     * [proposta] `timezone` is the zone whose midnight and day 1 turn the period (the daemon's own;
     * default `America/Sao_Paulo`, as `directives.timezone`); `unknown_cost` is what a turn of
     * unknown cost does to the cap (see {@link BUDGET_UNKNOWN_COST_MODES}); `ask_timeout` is how
     * long `on_exceeded: ask` waits for the Producer before it becomes `skip`; `on_cap_change`
     * (P11b) is whether a cap that was raised or removed lets an exhausted profile go at once.
     */
    budget: z
      .strictObject({
        timezone: z
          .string()
          .min(1)
          .refine(isKnownTimezone, 'expected an IANA time zone such as America/Sao_Paulo')
          .default(DEFAULT_DIRECTIVE_TIMEZONE),
        unknown_cost: z.enum(BUDGET_UNKNOWN_COST_MODES).default('ignore'),
        on_cap_change: z.enum(BUDGET_ON_CAP_CHANGE_MODES).default('release'),
        ask_timeout: DurationSchema.prefault('10m'),
      })
      .prefault({}),
    /**
     * The quota of each profile (architecture 5.6; P5). [proposta] `near_limit_at` is the fraction
     * of a window from which a profile is `near_limit` (architecture default 0.8). `stale_after` is
     * how old a reading may be and still authorize a route (a reading older than this makes the
     * state `unknown`; default 10 minutes). `probe.delivery` is how the service takes the probes of
     * the clients: see {@link QUOTA_PROBE_DELIVERY_MODES}; `probe.poll_every` is the gap between two
     * `read` calls where polling is on. The defaults follow N123, decided by the owner on
     * 2026-11-18.
     *
     * `recheck_every` (P9, architecture 5.6, "Consulta sem horário de reset"): how long a profile
     * that is exhausted with no known end waits before the daemon looks at it again, using only
     * signals that never call the model. `15m` by default; `off` never looks again (the profile
     * stays exhausted until a reading or a limit error says otherwise). A profile with no such
     * signal goes from `exhausted` to `unknown` when the interval passes.
     */
    quota: z
      .strictObject({
        near_limit_at: z.number().gt(0).max(1).default(0.8),
        stale_after: DurationSchema.prefault('10m'),
        probe: z
          .strictObject({
            delivery: z.enum(QUOTA_PROBE_DELIVERY_MODES).default('both'),
            poll_every: DurationSchema.prefault('5m'),
          })
          .prefault({}),
        recheck_every: z
          .union([z.literal('off'), DurationSchema])
          .transform((value) => (value === 'off' ? null : value))
          .prefault('15m'),
        /**
         * [proposta] (P8) The MiniMax Token Plan probe, a call the DAEMON makes with the key of the
         * profile. Default `off`: no call leaves the machine until the owner turns it on.
         * `base_url` and `allow_hosts` are the daemon network policy for this call (https only;
         * `http` only for a loopback host); `timeout` is the deadline of the call.
         */
        minimax: z
          .strictObject({
            mode: z.enum(QUOTA_MINIMAX_MODES).default('off'),
            base_url: z.url().default('https://api.minimax.io'),
            allow_hosts: z.array(z.string().min(1)).default(['api.minimax.io', 'www.minimax.io']),
            timeout: DurationSchema.prefault('10s'),
            usage_count_means: z.enum(QUOTA_MINIMAX_USAGE_COUNT_MEANS).default('remaining'),
          })
          .prefault({}),
        /**
         * [proposta] (P8) The OpenCode probe: local accounting of the usage events of the sessions
         * the daemon runs, over a rolling `window`. A limit left `null` is not measured; with both
         * `null` the ledger has nothing to compare with and gives no reading.
         */
        opencode: z
          .strictObject({
            mode: z.enum(QUOTA_OPENCODE_MODES).default('auto'),
            window: DurationSchema.prefault('5h'),
            limit_tokens: z.int().positive().nullable().default(null),
            limit_usd: z.number().positive().nullable().default(null),
          })
          .prefault({}),
      })
      .prefault({}),
    /**
     * Consumption and cost in money (architecture 5.6; P10). `monthly_price_usd` is the monthly
     * price of the plan of a subscription profile, by profile id (`<client>/<profile>`), which the
     * `prorated` display divides by the use of the month [proposta]: the architecture puts it "in
     * the profile", and `profiles.<id>` does not exist as a block yet (P11 brings it with the cap).
     */
    usage: z
      .strictObject({
        subscription_display: z
          .enum(USAGE_SUBSCRIPTION_DISPLAY_MODES)
          .default('quota_and_equivalent'),
        cost_source: z.enum(USAGE_COST_SOURCE_MODES).default('client_then_pricing'),
        api_gateway: z.enum(USAGE_API_GATEWAY_MODES).default('off'),
        monthly_price_usd: z.record(z.string().min(1), z.number().gt(0)).default({}),
        /**
         * The `ccusage` check (P12, N118: version 20.0.48 as a CLI of level C, a separate process the
         * owner installs). Off by default. When on, it reads each profile directory of the three
         * clients with the directory variables always set (never the logs of the owner's own
         * clients) and sets the figures against the `UsageService`; a gap above `tolerance` is a
         * warning and a `usage.notice`. Everything here is [proposta].
         */
        ccusage: z
          .strictObject({
            enabled: z.boolean().default(false),
            command_mode: z.enum(USAGE_CCUSAGE_COMMAND_MODES).default('explicit'),
            /** An absolute path (`explicit`) or a name (`path`, default `ccusage`). */
            command: z.string().min(1).optional(),
            /** The version `--version` must print; another one keeps the check off. */
            version: z
              .string()
              .regex(/^\d+\.\d+\.\d+$/, 'expected a version such as 20.0.48')
              .default('20.0.48'),
            timeout: DurationSchema.prefault('30s'),
            pricing: z.enum(USAGE_CCUSAGE_PRICING_MODES).default('offline'),
            compare: z.enum(USAGE_CCUSAGE_COMPARE_MODES).default('tokens'),
            /** The gap, as a fraction of the larger figure, above which the two disagree. */
            tolerance: z.number().min(0).max(1).default(0.1),
            /** A gap below these floors is never a divergence (a day with two turns). */
            min_tokens: z.int().min(0).default(1000),
            min_usd: z.number().min(0).default(0.5),
            /** How often the profiles are compared; `0` compares once, at start-up. */
            interval: DurationSchema.or(z.literal(0)).prefault('1h'),
            /** How many days back (UTC, today included) each comparison reaches. */
            window_days: z.int().min(1).max(90).default(7),
          })
          .refine(
            (c) =>
              !c.enabled ||
              c.command_mode === 'path' ||
              (c.command !== undefined && isAbsolute(c.command)),
            {
              path: ['command'],
              message:
                'usage.ccusage.command must be an absolute path when command_mode is explicit',
            },
          )
          .refine((c) => c.command_mode === 'explicit' || !/[\\/]/.test(c.command ?? ''), {
            path: ['command'],
            message: 'usage.ccusage.command must be a bare name when command_mode is path',
          })
          .prefault({}),
      })
      .prefault({}),
    /**
     * The price of a model, in US$ per million tokens, by model id: it adds to or replaces the
     * entry of the table that ships with the version (architecture 5.6, `pricing`). A model with
     * no entry in either has an unknown cost, never US$ 0. `cached_in_input` says the client counts
     * the cached tokens inside the input (OpenAI); `long_context` is a second card for a prompt
     * above `over_tokens` [proposta].
     */
    pricing: z.record(z.string().min(1), ModelPriceConfigSchema).default({}),
    ui: z
      .strictObject({
        locale: z.enum(LOCALE_SETTINGS).default('auto'),
        /**
         * What `ot` does with no command (Phase 7, P8; owner's choice of 2026-11-20): `tui` opens
         * the terminal interface when the input and the output are a terminal, `help` always shows
         * the usage, as before. Without a terminal it is the usage in either mode.
         */
        bare_command: z.enum(['tui', 'help']).default('tui'),
        /**
         * The layout preferences of the interfaces (architecture 5.13, N170; P12 of docs/17). The
         * daemon keeps them either way; these keys are what a client reads (`GET /v1/config`) to
         * know where to keep its own.
         */
        layout: z
          .strictObject({
            /**
             * Where a client keeps its layout: `daemon` (the record of its interface in the daemon,
             * by REST, so another client of the same user finds it) or `local` (a file in the
             * configuration folder of the client).
             */
            store: z.enum(LAYOUT_STORES).default('daemon'),
            /**
             * [proposta: 300ms] How long a client waits after the last change of its layout before it
             * writes it, so dragging the edge of the chat does not write once per column.
             */
            write_delay: DurationSchema.prefault('300ms'),
            /**
             * [proposta] How a client follows a layout another client changed (N174, 2026-11-20):
             * `live` applies the `layout.changed` event as it arrives; `on_open` reads the record
             * only when the screen opens. The daemon writes the event in both modes (it is also a
             * fact of the log, for hooks and plugins); the key is what a client reads. With
             * `store: local` the daemon keeps no record, so no event exists and the key is idle.
             */
            sync: z.enum(LAYOUT_SYNCS).default('live'),
          })
          .prefault({}),
        /**
         * The keymap of the terminal (architecture 5.13, N35; P7 of docs/18): the preset, and the
         * shortcuts the owner changes. The registry of `@otheater/client` checks the ids and refuses
         * a repeated shortcut, so the daemon does not start with a keymap the interface cannot use.
         */
        keymap: UiKeymapConfigSchema.superRefine((keymap, ctx) => {
          const result = resolveKeymap(DEFAULT_UI_REGISTRY, {
            preset: keymap.preset,
            overrides: keymap.overrides,
          });
          if (result.ok) return;
          for (const error of result.errors)
            ctx.addIssue({
              code: 'custom',
              path: ['overrides', error.actionId],
              message: error.message,
            });
        }).prefault({}),
        /** How the terminal interface copies text (N36). */
        clipboard: UiClipboardConfigSchema.prefault({}),
        /** The mouse of the terminal interface (N34): `full`, `wheel` or `off`. */
        mouse: UiMouseModeSchema.default('full'),
        /** The rendering of the terminal interface (N37). */
        render: UiRenderConfigSchema.prefault({}),
        /** The Node runtime of the terminal interface (N37). */
        runtime: UiRuntimeConfigSchema.prefault({}),
        /** The measures and steps of the screen of the terminal interface (P9 of docs/18). */
        tuiLayout: UiTuiLayoutConfigSchema.prefault({}),
        /** The text box of the terminal interface (N35): paste, history, editor and image. */
        input: UiInputConfigSchema.prefault({}),
        /** The Trajectories tab of the terminal interface (P14 of docs/18). */
        trajectories: UiTrajectoriesConfigSchema.prefault({}),
        /** The chat of the terminal interface (P12): queue, suggestions, decisions and Esc. */
        chat: UiChatConfigSchema.prefault({}),
        /** The Overview tab: confirmation, recent events (P13 of docs/18). */
        overview: UiOverviewConfigSchema.prefault({}),
        /** The Usage tab: how the totals are split (P13 of docs/18). */
        usage: UiUsageConfigSchema.prefault({}),
        /** The wheel step and the copy limit of the mouse of the terminal interface (P11). */
        tuiMouse: UiTuiMouseConfigSchema.prefault({}),
        /** Whether the terminal interface opens the setup assistant on its own (P17). */
        setup: UiSetupConfigSchema.prefault({}),
        /** What the prompt of "new project" starts with (P22 of docs/18). */
        newProject: UiNewProjectConfigSchema.prefault({}),
        /** The finished plays in the side bar of the terminal interface (P11 of docs/19). */
        sidebar: UiSidebarConfigSchema.prefault({}),
      })
      .prefault({}),
    /**
     * The setup assistant (architecture 5.7, N121; P4 of docs/18). [proposta] Both keys are what
     * the assistant proposes; the Producer changes them in the `executors` step or by hand later.
     */
    setup: z
      .strictObject({
        /**
         * The cap the `executors` step proposes for an API account that got an Executor and was
         * given no cap (5.6: an API account should always have one). A step may answer a cap of its
         * own, or `null` in both fields for "no cap".
         */
        suggested_budget: z
          .strictObject({
            daily_usd: z.number().gt(0).default(20),
            monthly_usd: z.number().gt(0).default(200),
          })
          .prefault({}),
        /**
         * What `confirm` writes of the lists of the roles: `explicit` writes `roles.<role>.executors`
         * for every role (what the Producer saw at the review stays as it is even if the preset
         * changes later); `preset` writes only `roles.preset` and the Executors, and the lists keep
         * following the preset.
         */
        role_lists: z.enum(SETUP_ROLE_LIST_MODES).default('explicit'),
      })
      .prefault({}),
    log: z
      .strictObject({
        level: z.enum(LOG_LEVELS).default('info'),
        destination: z.enum(LOG_DESTINATIONS).default('file'),
        /**
         * The rotation of `daemon.log` (Phase 8, P8; [proposta]). `mode: size` (default): when the
         * file would pass `max_mb` it becomes `daemon.log.1` (the older copies move up) and a new
         * file starts; `keep` copies stay (`0`: none, the full file is dropped); `off`: it grows.
         */
        rotate: z
          .strictObject({
            mode: z.enum(LOG_ROTATE_MODES).default('size'),
            max_mb: z.int().min(1).max(10_240).default(20),
            keep: z.int().min(0).max(100).default(5),
          })
          .prefault({}),
      })
      .prefault({}),
  })
  .refine(
    (config) => !(hasSecretPathEntries(config.security) && hasSecretPathEntries(config.browser)),
    {
      path: ['browser', 'secret_paths'],
      message:
        'browser.secret_paths is an alias of security.secret_paths: write the list in one of them, not in both',
    },
  );

/** Whether a block with a `secret_paths` key (`security`, `browser`) has an entry in it. */
function hasSecretPathEntries(block: {
  readonly secret_paths: { readonly add: readonly string[]; readonly remove: readonly string[] };
}): boolean {
  return block.secret_paths.add.length > 0 || block.secret_paths.remove.length > 0;
}

/**
 * The `add` and `remove` of the one list of secret paths (architecture 5.19): `security.secret_paths`,
 * or its alias `browser.secret_paths` when that is where the owner wrote it. The schema refuses both.
 */
export function secretPathEntries(config: Pick<DaemonConfig, 'security' | 'browser'>): {
  readonly add: readonly string[];
  readonly remove: readonly string[];
} {
  return hasSecretPathEntries(config.security)
    ? config.security.secret_paths
    : config.browser.secret_paths;
}

/** What a user may write (every key optional). */
export type DaemonConfigInput = z.input<typeof DaemonConfigSchema>;
/** The validated configuration with every default filled in. */
export type DaemonConfig = z.output<typeof DaemonConfigSchema>;
export type BackupSettings = DaemonConfig['backup'];

/** Message that points at the key, e.g. `backup.keep_days: Too small: ...`. */
export function describeZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.map(String).join('.');
      return path === '' ? issue.message : `${path}: ${issue.message}`;
    })
    .join('; ');
}

/** Parses the text of a `config.yaml`. `source` only names the file in the messages. */
export function parseConfig(text: string, source = 'config.yaml'): DaemonConfig {
  let raw: unknown;
  try {
    // YAML 1.2 (the library default): `03:00` stays a string, `no` stays a string.
    raw = parseYaml(text);
  } catch (error) {
    const detail = error instanceof YAMLParseError ? error.message : String(error);
    throw new InvalidInput(`${source}: not valid YAML: ${detail}`, { cause: error });
  }
  // An empty file (or only comments) parses as null: same as no file.
  const parsed = DaemonConfigSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new InvalidInput(`${source}: ${describeZodError(parsed.error)}`, { cause: parsed.error });
  }
  return parsed.data;
}

/** Reads `config.yaml`; a missing file is the default configuration. */
export async function loadConfig(configPath: string): Promise<DaemonConfig> {
  let text: string;
  try {
    text = await readFile(configPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return parseConfig('', configPath);
    throw new InvalidInput(`Cannot read ${configPath}: ${String(error)}`, { cause: error });
  }
  return parseConfig(text, configPath);
}

/**
 * `K` of a client: `pool.<client>.sessions_per_process` (default 6 for Codex, 4 for OpenCode, N74),
 * or else the global `pool.sessions_per_process` for a client without one (Claude Code).
 */
export function sessionsPerProcessOf(pool: DaemonConfig['pool'], client: ClientId): number {
  return pool[client].sessions_per_process ?? pool.sessions_per_process;
}

/** `session_mb` of a client (`pool.<client>.session_mb`): a number of MB, or `auto`. */
export function sessionMbOf(pool: DaemonConfig['pool'], client: ClientId): number | 'auto' {
  return pool[client].session_mb;
}
