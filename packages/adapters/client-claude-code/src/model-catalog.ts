// SPDX-License-Identifier: MPL-2.0
import type {
  Executor,
  ExecutorDraft,
  ModelCatalog,
  ModelInfo,
  ProfileRef,
  ValidationIssue,
  ValidationResult,
} from '@otheater/core';

/**
 * The model catalog of Claude Code (architecture 5.2, 5.7), `discovery: 'automatic'`.
 *
 * The client lists its own models and efforts: `claude-agent-acp` announces them in the config
 * options of `session/new` (`model` and `effort`, the latter with category `thought_level`).
 * [V: Phase 0 item 2, `claude` 2.1.325 with adapter 0.107.0, one profile]. What the list holds
 * depends on the account (the run saw `claude-fable-5-2[1m]` next to the aliases), so a fixed
 * list cannot stand in for it; it can only back it up.
 *
 * Two sources, chosen by `clients.claude-code.model_catalog` [proposta]:
 * - `session`: the list comes from a {@link ConfigOptionsReader}, which opens a session of the
 *   profile without sending a prompt and returns its `configOptions`. The daemon plugs it in (it
 *   owns the transport and the launcher); this package does not start a client by itself.
 * - `reserve`: the {@link RESERVE_MODELS} list, with no process started.
 * - `session_or_reserve` (default): `session`, and the reserve when the reader is missing or
 *   fails. A model that is not in the reserve is then a warning, not an error, because the
 *   reserve is not the account's list.
 */

/** Where the list comes from. */
export const MODEL_CATALOG_SOURCES = ['session', 'reserve', 'session_or_reserve'] as const;
export type ModelCatalogSource = (typeof MODEL_CATALOG_SOURCES)[number];

/** Family of every model of this client: the key of the cross-review (architecture 5.7). */
export const CLAUDE_FAMILY = 'anthropic';

/** Id of the `model` config option. [V] */
export const MODEL_OPTION_ID = 'model';
/** Id of the effort config option (category `thought_level`). [V] */
export const EFFORT_OPTION_ID = 'effort';

/** One model of a listing, in the ids of the client. */
export interface ClaudeModelEntry {
  readonly id: string;
  readonly name?: string;
}

/** What a listing says: the models and the efforts, as the client announced them. */
export interface ClaudeCatalogSnapshot {
  readonly models: readonly ClaudeModelEntry[];
  /** One list for every model: the run showed no per-model efforts. [N] that none exist. */
  readonly efforts: readonly string[];
}

/**
 * Backup list, used when no session can be opened. The ids are the aliases of the `model` option
 * and the levels of the `effort` option of the Phase 0 run [V]; which efforts each model accepts
 * is not known [N]. It has no `claude-fable-5-2[1m]`: that one depended on the account.
 */
export const RESERVE_SNAPSHOT: ClaudeCatalogSnapshot = {
  models: [
    { id: 'default', name: 'Default' },
    { id: 'opus', name: 'Opus' },
    { id: 'sonnet', name: 'Sonnet' },
    { id: 'haiku', name: 'Haiku' },
  ],
  efforts: ['default', 'low', 'medium', 'high', 'xhigh', 'max'],
};

/** The effort `suggest` proposes when the model accepts it: the default of the Phase 0 run. [V] */
export const SUGGESTED_EFFORT = 'high';

/** Context window of the models whose id says `[1m]`. [S: the suffix of the alias] */
const ONE_MILLION = 1_000_000;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The `{value, name}` leaves of a select option, with the groups of the ACP `SessionConfigSelect` flattened. */
function selectValues(options: unknown): ClaudeModelEntry[] {
  if (!Array.isArray(options)) return [];
  const found: ClaudeModelEntry[] = [];
  for (const raw of options as unknown[]) {
    const entry = record(raw);
    if (Array.isArray(entry?.options)) {
      found.push(...selectValues(entry.options));
      continue;
    }
    if (typeof entry?.value !== 'string' || entry.value === '') continue;
    found.push(
      typeof entry.name === 'string' && entry.name !== ''
        ? { id: entry.value, name: entry.name }
        : { id: entry.value },
    );
  }
  return found;
}

/**
 * Reads the `configOptions` of a `session/new` answer. `undefined` when there is no `model`
 * option (a client that is not the one expected must not be taken for an empty catalog).
 * [V: shape of Phase 0 item 2; the nesting of groups follows the ACP schema [S]]
 */
export function readConfigOptions(configOptions: unknown): ClaudeCatalogSnapshot | undefined {
  if (!Array.isArray(configOptions)) return undefined;
  let models: ClaudeModelEntry[] | undefined;
  let efforts: string[] = [];
  for (const raw of configOptions as unknown[]) {
    const option = record(raw);
    if (option === undefined) continue;
    if (option.id === MODEL_OPTION_ID) models = selectValues(option.options);
    if (option.id === EFFORT_OPTION_ID || option.category === 'thought_level') {
      efforts = selectValues(option.options).map((entry) => entry.id);
    }
  }
  return models === undefined || models.length === 0 ? undefined : { models, efforts };
}

/**
 * Opens a session of the profile with no prompt and returns the `configOptions` of `session/new`
 * as they came (and closes it). It rejects when the client cannot start (no login does not stop
 * `session/new`, [V] Phase 0). [proposta] The daemon builds it from the ACP transport.
 */
export type ConfigOptionsReader = (profile: ProfileRef) => Promise<unknown>;

export interface ClaudeModelCatalogOptions {
  /** Default `session_or_reserve`. */
  readonly source?: ModelCatalogSource;
  readonly reader?: ConfigOptionsReader;
  /** How long a listing of a profile is kept, in ms. Default 5 minutes; `0` keeps nothing. [proposta] */
  readonly cacheMs?: number;
  /** Default `Date.now`. */
  readonly now?: () => number;
}

interface Listing {
  readonly snapshot: ClaudeCatalogSnapshot;
  readonly fromReserve: boolean;
  /** Why the reserve was used, when it was and a session was wanted. */
  readonly reason?: string;
}

function toInfo(entry: ClaudeModelEntry, efforts: readonly string[]): ModelInfo {
  return {
    id: entry.id,
    ...(entry.name === undefined ? {} : { name: entry.name }),
    family: CLAUDE_FAMILY,
    efforts,
    local: false,
    // Every model of Claude Code calls tools. [S: the product is a tool-using agent]
    toolCalls: true,
    ...(entry.id.endsWith('[1m]') ? { contextWindow: ONE_MILLION } : {}),
  };
}

export class ClaudeModelCatalog implements ModelCatalog {
  readonly discovery = 'automatic';
  readonly #source: ModelCatalogSource;
  readonly #reader: ConfigOptionsReader | undefined;
  readonly #cacheMs: number;
  readonly #now: () => number;
  readonly #cache = new Map<string, { at: number; listing: Listing }>();

  constructor(options: ClaudeModelCatalogOptions = {}) {
    this.#source = options.source ?? 'session_or_reserve';
    this.#reader = options.reader;
    this.#cacheMs = options.cacheMs ?? 300_000;
    this.#now = options.now ?? Date.now;
  }

  async list(profile: ProfileRef): Promise<readonly ModelInfo[]> {
    const { snapshot } = await this.#listing(profile);
    return snapshot.models.map((entry) => toInfo(entry, snapshot.efforts));
  }

  suggest(model: ModelInfo): Partial<ExecutorDraft> {
    return {
      family: model.family ?? CLAUDE_FAMILY,
      local: false,
      ...(model.efforts.includes(SUGGESTED_EFFORT) ? { effort: SUGGESTED_EFFORT } : {}),
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
    };
  }

  async validate(executor: Executor): Promise<ValidationResult> {
    let listing: Listing;
    try {
      listing = await this.#listing(executor.profile);
    } catch (cause) {
      return failed({
        code: 'profile_invalid',
        severity: 'error',
        message: `the model list of ${executor.profile.client}/${executor.profile.profile} could not be read: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      });
    }
    const issues: ValidationIssue[] = [];
    const { snapshot, fromReserve } = listing;
    if (listing.reason !== undefined) {
      issues.push({
        code: 'profile_invalid',
        severity: 'warning',
        message: `the model list of the profile was not read (${listing.reason}); the reserve list was used`,
      });
    }
    const model = snapshot.models.find((entry) => entry.id === executor.model);
    if (model === undefined) {
      issues.push({
        code: 'model_not_found',
        // The reserve is not the account's list: an id it lacks may still exist.
        severity: fromReserve ? 'warning' : 'error',
        message: `the model ${executor.model} is not in the ${fromReserve ? 'reserve' : 'client'} list (${snapshot.models
          .map((entry) => entry.id)
          .join(', ')})`,
      });
    }
    if (executor.effort !== undefined && !snapshot.efforts.includes(executor.effort)) {
      issues.push({
        code: 'effort_not_accepted',
        severity: fromReserve ? 'warning' : 'error',
        message: `the effort ${executor.effort} is not in the list (${snapshot.efforts.join(', ') || 'none'})`,
      });
    }
    return { ok: !issues.some((issue) => issue.severity === 'error'), issues };
  }

  async #listing(profile: ProfileRef): Promise<Listing> {
    const key = `${profile.client}/${profile.profile}`;
    const hit = this.#cache.get(key);
    if (hit !== undefined && this.#now() - hit.at < this.#cacheMs) return hit.listing;
    const listing = await this.#read(profile);
    // A listing that fell back is not kept: the next call tries the session again.
    if (this.#cacheMs > 0 && listing.reason === undefined) {
      this.#cache.set(key, { at: this.#now(), listing });
    }
    return listing;
  }

  async #read(profile: ProfileRef): Promise<Listing> {
    if (this.#source === 'reserve') return { snapshot: RESERVE_SNAPSHOT, fromReserve: true };
    let reason: string;
    if (this.#reader === undefined) {
      reason = 'no reader was given';
    } else {
      try {
        const snapshot = readConfigOptions(await this.#reader(profile));
        if (snapshot !== undefined) return { snapshot, fromReserve: false };
        reason = 'the session announced no model option';
      } catch (cause) {
        if (this.#source === 'session') throw cause;
        reason = cause instanceof Error ? cause.message : String(cause);
      }
    }
    if (this.#source === 'session') throw new Error(reason);
    // `session_or_reserve` without a reader is the quiet case: nobody asked for a session.
    return {
      snapshot: RESERVE_SNAPSHOT,
      fromReserve: true,
      ...(this.#reader === undefined ? {} : { reason }),
    };
  }
}

function failed(issue: ValidationIssue): ValidationResult {
  return { ok: false, issues: [issue] };
}
