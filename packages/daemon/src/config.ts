// SPDX-License-Identifier: MPL-2.0
import { readFile } from 'node:fs/promises';
import {
  DEFAULT_DIRECTIVE_TIMEZONE,
  DEFAULT_SUMMARY_MESSAGES,
  DEFAULT_SHELL_ALLOWLIST,
  DELIVERY_MODES,
  InvalidInput,
  isKnownTimezone,
  parseAllowEntry,
  ProjectCommandSchema,
  PROMPT_ORDER_MODES,
  SHARED_CANCEL_MODES,
  TRUNCATE_MODES,
} from '@otheater/core';
import { BACKUP_CONTENTS } from '@otheater/protocol';
import { parse as parseYaml, YAMLParseError } from 'yaml';
import { z } from 'zod';
import {
  ADMISSION_MODES,
  DEFAULT_ADMISSION,
  DEFAULT_SESSION_MB,
  FALLBACK_SESSION_MB,
  UNKNOWN_RAM_MODES,
} from './execution/admission.js';
import { IdeasConfigSchema } from './ideas/settings.js';
import { ExecutorsConfigSchema } from './role-executors-config.js';
import { RolesConfigSchema } from './role-policy-config.js';

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
 * [proposta] `quota.probe.delivery`: how the `QuotaService` takes the readings of a probe. `both`
 * (default) watches the probes that can push and also polls `read` on a timer; `push` only
 * watches (a probe without `watch` is not used); `poll` only calls `read` on a timer.
 */
export const QUOTA_PROBE_DELIVERY_MODES = ['both', 'push', 'poll'] as const;

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
export const CLAUDE_UTILIZATION_UNITS = ['ignore', 'fraction', 'percent'] as const;
export const CLAUDE_ACCOUNT_ENV = ['strip', 'keep'] as const;
export const CLAUDE_MODEL_CATALOG_SOURCES = ['session', 'reserve', 'session_or_reserve'] as const;
export const CODEX_PROCESS_MODELS = ['multi-session', 'process-per-session'] as const;
/**
 * [proposta] Where the Codex model list comes from: `session` opens a session of the profile
 * without a prompt and reads its config options; `none` reads nothing (`models.list` rejects).
 */
export const CODEX_MODEL_CATALOG_SOURCES = ['session', 'none'] as const;

export const CODEX_CREDENTIALS_STORES = ['file', 'keyring', 'auto'] as const;
export const CODEX_APPROVAL_POLICIES = ['on-request', 'untrusted'] as const;
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
 * `sandbox.mcp_bridge` (N115): how a confined client reaches the MCP server of the daemon, which
 * listens on the loopback of the host (a sandbox on Linux has its own loopback). `proxy`: a listener
 * inside the sandbox on the same port forwards to the host over the proxy of the sandbox library
 * (TCP only, the Unix-socket filter stays on); `off`: no listener, only the `localhost:<port>`
 * domain rule, which a client that honours `NO_PROXY` cannot use.
 */
export const SANDBOX_MCP_BRIDGE_MODES = ['proxy', 'off'] as const;
export type SandboxMcpBridgeMode = (typeof SANDBOX_MCP_BRIDGE_MODES)[number];

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

/** The resolved `limits` of the configuration: the values plus the name of the preset. */
export interface ResolvedLimits extends PlayLimits {
  readonly preset: LimitPresetName;
}

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
  limits: { preset: LimitPresetName } & { [K in keyof PlayLimits]?: number | undefined },
): ResolvedLimits {
  const preset = LIMIT_PRESETS[limits.preset];
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
 * `profiles.same_provider_notice` (Phase 5, P2; N127 is open). [proposta] When registering a second
 * subscription profile of the same provider: `once` warns until the Producer accepts it (the
 * acceptance is recorded on the profile, `noticeAcceptedAt`, and a later profile of that provider is
 * not warned again); `always` warns on every such profile; `off` never warns. An API profile never
 * triggers it, in any mode.
 */
export const SAME_PROVIDER_NOTICE_MODES = ['once', 'always', 'off'] as const;
export type SameProviderNoticeMode = (typeof SAME_PROVIDER_NOTICE_MODES)[number];

/**
 * `profiles.drain.on_timeout` (Phase 5, P2; N127 is open). [proposta] What happens to the sessions
 * still running when `profiles.drain.timeout` ends: `handoff` takes them off the profile and back
 * to the queue (the real handoff is P18/P20/P21; P2 only returns them to the queue); `wait` keeps
 * the profile `draining` until they end; `force` closes them.
 */
export const DRAIN_ON_TIMEOUT_MODES = ['handoff', 'wait', 'force'] as const;
export type DrainOnTimeoutMode = (typeof DRAIN_ON_TIMEOUT_MODES)[number];

/**
 * `profiles.drain.removed_dir` (Phase 5, P2; N127 is open). [proposta] What removal does with the
 * directory of the profile, after the logout: `delete` removes it; `keep_backup` moves it aside
 * (`<name>.removed-<epoch>`, next to it, inside `profiles/`) instead of deleting.
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

export const CHAT_CHANNEL_MODES = ['auto', 'off'] as const;
export type ChatChannelMode = (typeof CHAT_CHANNEL_MODES)[number];

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
 * Who counts as watching a play (decision of P15a, [proposta]). `poll` (default): an `ot chat`
 * that polled the scenario of the play within `chat.presence_window`; `always`: someone is always
 * there (the Producer is trusted to answer); `never`: nobody is, so `delivery.base_drift: ask`
 * acts as `update`.
 */
export const CHAT_PRESENCE_MODES = ['poll', 'always', 'never'] as const;
export type ChatPresenceMode = (typeof CHAT_PRESENCE_MODES)[number];

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
  suggested_effort: z.string().min(1).default('high'),
  model_catalog: z.enum(CODEX_MODEL_CATALOG_SOURCES).default('session'),
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
      })
      .prefault({})
      .transform(resolveLimits)
      .refine((limits) => limits.demand_timeout <= limits.demand_timeout_max, {
        message: 'demand_timeout must not exceed demand_timeout_max',
        path: ['demand_timeout'],
      }),
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
     * The chat of the Producer with the Director (architecture 5.3 and 5.4; N78, P8). `channel`:
     * `auto` (default) opens the local channel `ot chat` talks to (127.0.0.1, a port the system
     * picks, a token in a file of the data directory); `off` leaves it closed. `history` is how many
     * replies of the Director the channel keeps in memory per scenario for `ot chat` to show.
     * `presence` and `presence_window` say when a play counts as watched (`delivery.base_drift: ask`).
     */
    chat: z
      .strictObject({
        channel: z.enum(CHAT_CHANNEL_MODES).default('auto'),
        history: z.int().min(1).default(200),
        /** [proposta] Who counts as watching a play: see {@link CHAT_PRESENCE_MODES}. */
        presence: z.enum(CHAT_PRESENCE_MODES).default('poll'),
        /** [proposta] How long after its last poll an `ot chat` still counts as present (`presence: poll`). */
        presence_window: DurationSchema.prefault('30s'),
      })
      .prefault({}),
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
        /** [proposta] What the Executor is told when a conversation is reloaded. */
        continue_prompt: z
          .string()
          .min(1)
          .default('Continue the task from where you stopped. Do not start over.'),
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
          continue_prompt: resume.continue_prompt,
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
        /** [proposta, N115] `proxy` (default) bridges the MCP server of the daemon into the sandbox; `off` does not. */
        mcp_bridge: z.enum(SANDBOX_MCP_BRIDGE_MODES).default('proxy'),
      })
      .prefault({}),
    tools: ToolsConfigSchema,
    browser: BrowserConfigSchema,
    events: z
      .strictObject({
        /** N80: `reject` (default) refuses an unknown type or an invalid payload; `warn` stores it and logs. */
        unknown_type: z.enum(EVENT_UNKNOWN_TYPE_MODES).default('reject'),
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
     */
    scenarios: z
      .strictObject({
        director_idle_after: DurationSchema.or(z.literal(0)).prefault('15m'),
        attachment_max_size: SizeSchema.or(z.literal(0)).prefault('50MB'),
        attachment_read_max: SizeSchema.prefault('8MB'),
        consultant_alternatives: z.array(PlayExecutorSchema).default([]),
        consultant_writes: z.enum(['merge', 'keep', 'discard']).prefault('merge'),
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
     * owner on 2026-11-18; `same_provider_notice` and `api_key_env` are [proposta].
     */
    profiles: z
      .strictObject({
        same_provider_notice: z.enum(SAME_PROVIDER_NOTICE_MODES).default('once'),
        drain: z
          .strictObject({
            /** How long a drain waits for the running sessions before `on_timeout` applies. */
            timeout: DurationSchema.or(z.literal(0)).prefault('10m'),
            on_timeout: z.enum(DRAIN_ON_TIMEOUT_MODES).default('handoff'),
            removed_dir: z.enum(REMOVED_DIR_MODES).default('delete'),
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
      })
      .prefault({}),
    ui: z
      .strictObject({
        locale: z.enum(LOCALE_SETTINGS).default('auto'),
      })
      .prefault({}),
    log: z
      .strictObject({
        level: z.enum(LOG_LEVELS).default('info'),
        destination: z.enum(LOG_DESTINATIONS).default('file'),
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
