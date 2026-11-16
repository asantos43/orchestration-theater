// SPDX-License-Identifier: MPL-2.0
import { readFile } from 'node:fs/promises';
import { InvalidInput } from '@otheater/core';
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
export const OPENCODE_PROCESS_MODELS = ['per_profile', 'per_session'] as const;
export const RESUME_PRESET_NAMES = ['balanced', 'patient', 'agile'] as const;

/**
 * The `resume.preset` table of architecture 5.16 (decision N14): one row fills every value at once,
 * and an individual key overrides only its own value. `transient_backoff` does not change with the
 * preset ([proposta] in 5.16).
 */
export const RESUME_PRESETS = {
  balanced: {
    max_resumes: 5,
    quota_wait_max: 30 * 60_000,
    checkpoint_every: 10 * 60_000,
    no_event_for: 10 * 60_000,
    same_error_times: 3,
  },
  patient: {
    max_resumes: 8,
    quota_wait_max: 2 * 3_600_000,
    checkpoint_every: 15 * 60_000,
    no_event_for: 20 * 60_000,
    same_error_times: 5,
  },
  agile: {
    max_resumes: 3,
    quota_wait_max: 10 * 60_000,
    checkpoint_every: 5 * 60_000,
    no_event_for: 5 * 60_000,
    same_error_times: 2,
  },
} as const;

/** `all` (one step for the whole database) or a page count per step, an integer >= 1. */
export const PagesPerStepSchema = z.union([z.literal('all'), z.int().min(1)]);

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
    })
    .prefault({}),
  /** `SqliteStoreConfigSchema` without `path` (the path is `<data>/store.sqlite`). */
  store: AdapterSection.prefault({}),
  /** Config of the chosen vault adapter (keyring: service, linuxStore; encrypted-file: path, scrypt). */
  vault: AdapterSection.prefault({}),
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
   * is the `K` of the text and `idle` its `idleMs`; the other keys are [proposta].
   */
  pool: z
    .strictObject({
      /** `K`: sessions per adapter process, for the clients that share one (`multi-session`). */
      sessions_per_process: z.int().min(1).default(4),
      /** Admission semaphore: sessions running at once, counted per session and not per process. */
      max_sessions: z.int().min(1).default(4),
      /** A process with no session for this long is closed (`idleMs`). */
      idle: DurationSchema.prefault('2m'),
      /** N56 (5.2): how OpenCode shares its processes. The adapter wiring reads it; the pool follows the adapter's `processModel`. */
      opencode: z
        .strictObject({ process_model: z.enum(OPENCODE_PROCESS_MODELS).default('per_profile') })
        .prefault({}),
    })
    .prefault({}),
  /** The timeout keys of `limits` (architecture 5.4); the other keys of that group are not wired yet. */
  limits: z
    .strictObject({
      /** When the plan does not set `timeoutMin` for the demand. */
      demand_timeout: DurationSchema.prefault('30m'),
      /** Ceiling of what the plan may ask for. */
      demand_timeout_max: DurationSchema.prefault('2h'),
    })
    .prefault({})
    .refine((limits) => limits.demand_timeout <= limits.demand_timeout_max, {
      message: 'demand_timeout must not exceed demand_timeout_max',
      path: ['demand_timeout'],
    }),
  /** Retries and checkpoints (architecture 5.16). Resolved: the preset is already applied. */
  resume: z
    .strictObject({
      preset: z.enum(RESUME_PRESET_NAMES).default('balanced'),
      max_resumes: z.int().min(0).optional(),
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
