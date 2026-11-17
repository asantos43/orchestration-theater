// SPDX-License-Identifier: MPL-2.0
import { readFile } from 'node:fs/promises';
import {
  DEFAULT_DIRECTIVE_TIMEZONE,
  DEFAULT_SUMMARY_MESSAGES,
  DELIVERY_MODES,
  InvalidInput,
  isKnownTimezone,
  PROMPT_ORDER_MODES,
  SHARED_CANCEL_MODES,
} from '@otheater/core';
import { BACKUP_CONTENTS } from '@otheater/protocol';
import { parse as parseYaml, YAMLParseError } from 'yaml';
import { z } from 'zod';

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

export const CHAT_CHANNEL_MODES = ['auto', 'off'] as const;
export type ChatChannelMode = (typeof CHAT_CHANNEL_MODES)[number];

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

/**
 * `pool.<client>`: what the pool decides for one client alone. `sessions_per_process` (`K`) has a
 * default of its own only where a real measurement justified one (N74, owner's decision,
 * 2026-11-16: Codex 6, OpenCode 4); a client without one (Claude Code) inherits the global
 * `pool.sessions_per_process`.
 */
export const PoolClientSchema = z.strictObject({
  /** `K` of this client; absent: `pool.sessions_per_process`. */
  sessions_per_process: z.int().min(1).optional(),
});

/** `pool.codex`: `K` defaults to 6 (N74, measured on 2026-11-16). */
export const PoolCodexSchema = PoolClientSchema.extend({
  sessions_per_process: z.int().min(1).default(6),
});

/** `clients.opencode` (keys of `OpenCodeAdapterOptions`; `pool.opencode.process_model` is under `pool`). */
export const OpenCodeClientSchema = z.strictObject({
  ...clientCommon,
  /** Default `opencode acp`. */
  command: ClientCommandSchema.optional(),
  isolation: z.array(z.enum(OPENCODE_ISOLATED_HOMES)).default(['data', 'config']),
  /** The `opencode.json` of the profile: an object, `null` for no file, absent for the adapter's default. */
  profile_config: z.record(z.string(), z.unknown()).nullable().optional(),
  shell_keys: z.array(z.string().min(1)).min(1).default(['bash']),
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
export const DaemonConfigSchema = z.strictObject({
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
      /** `K` of Claude Code alone; no default of its own (inherits the global key, 4). */
      'claude-code': PoolClientSchema.prefault({}),
      /** `K` of Codex alone; default 6 (N74, real measurement of 2026-11-16). */
      codex: PoolCodexSchema.prefault({}),
      /**
       * N56 (5.2): how OpenCode shares its processes (the adapter wiring reads `process_model`; the
       * pool follows the adapter's `processModel`), and `K` of OpenCode alone (default 4, explicit:
       * N74, real measurement of 2026-11-16).
       */
      opencode: PoolClientSchema.extend({
        sessions_per_process: z.int().min(1).default(4),
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
   * The chat of the Producer with the Director (architecture 5.3 and 5.4; N78, P8). `channel`:
   * `auto` (default) opens the local channel `ot chat` talks to (127.0.0.1, a port the system
   * picks, a token in a file of the data directory); `off` leaves it closed. `history` is how many
   * replies of the Director the channel keeps in memory per scenario for `ot chat` to show.
   */
  chat: z
    .strictObject({
      channel: z.enum(CHAT_CHANNEL_MODES).default('auto'),
      history: z.int().min(1).default(200),
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
   * happens when they do not. Until the Sandbox exists (Phase 4), `writeScope` and `network` have
   * no layer, so the defaults refuse sessions with those fields; `unenforced: warn` lets them run.
   */
  security: z
    .strictObject({
      min_layers: z
        .strictObject({
          default: z.int().min(0).default(1),
          nativeTools: z.int().min(0).optional(),
          nativeShell: z.int().min(0).optional(),
          mcpServers: z.int().min(0).optional(),
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
    })
    .prefault({}),
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
   * Delivery policy (architecture 5.5, owner's decision N5). `mode` is the global value; the
   * override per project, play and scheduled task is the rule registry's `delivery.mode`.
   * `allow_direct_merge` is the project's permission: without it `direct_merge` and `ask` become
   * `pr`. Default: open the PR and stop.
   */
  delivery: z
    .strictObject({
      mode: z.enum(DELIVERY_MODES).default('pr'),
      allow_direct_merge: z.boolean().default(false),
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
});

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
