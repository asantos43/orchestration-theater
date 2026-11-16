// SPDX-License-Identifier: MPL-2.0
import type { Executor, ProfileRef } from './executor.js';

/** Semver of the `ModelCatalog` port contract (architecture 5.18, "Versão dos contratos"). */
export const MODEL_CATALOG_PORT_VERSION = '0.1.0';

/** Price of a model in USD per million tokens (architecture 5.6, table `pricing`). */
export interface ModelCost {
  readonly inputPerMTokUsd: number;
  readonly outputPerMTokUsd: number;
  readonly cacheReadPerMTokUsd?: number;
  readonly cacheWritePerMTokUsd?: number;
}

/** A model a client offers on a profile (architecture 5.2, 5.7). */
export interface ModelInfo {
  /** Id as the client's catalog lists it; what goes into the Executor. */
  readonly id: string;
  readonly name?: string;
  /** Family or provider of the model (`anthropic`, `openai`, `google`...): the key of the cross-review (5.7). */
  readonly family?: string;
  /** Effort/thought levels the model accepts, in the client's own ids. Empty: no effort control. */
  readonly efforts: readonly string[];
  /** Runs on this machine (a `LocalModelServer`), not in a cloud. */
  readonly local: boolean;
  /** Can call tools; `undefined` when the catalog does not say. */
  readonly toolCalls?: boolean;
  /** Context window in tokens; for a local model, per slot. */
  readonly contextWindow?: number;
  readonly cost?: ModelCost;
}

/** What `suggest` fills in for the setup assistant; the Producer confirms it (architecture 5.7). */
export interface ExecutorDraft {
  readonly effort: string;
  readonly family: string;
  readonly local: boolean;
  readonly contextWindow: number;
  readonly cost: ModelCost;
}

export const VALIDATION_SEVERITIES = ['error', 'warning'] as const;

export const VALIDATION_ISSUE_CODES = [
  'model_not_found',
  'effort_not_accepted',
  'no_tool_calls',
  'context_too_small',
  'profile_invalid',
] as const;

export interface ValidationIssue {
  readonly code: (typeof VALIDATION_ISSUE_CODES)[number];
  readonly severity: (typeof VALIDATION_SEVERITIES)[number];
  readonly message: string;
}

/** Outcome of `validate`: `ok` is true when there is no `error` issue (warnings do not fail it). */
export interface ValidationResult {
  readonly ok: boolean;
  readonly issues: readonly ValidationIssue[];
}

/**
 * The models of one client and the checks on an Executor (architecture 5.2, 5.7). It is not an
 * `Adapter`: it belongs to the `ClientAdapter` (the `models` member) and is versioned with it.
 * The type is a port of its own so the Settings screen and the selection can use it without the
 * client behind it.
 */
export interface ModelCatalog {
  /** `automatic`: the client lists its models (Claude Code, Codex). `assisted`: the Producer helps (OpenCode). */
  readonly discovery: 'automatic' | 'assisted';
  list(profile: ProfileRef): Promise<readonly ModelInfo[]>;
  suggest(model: ModelInfo): Partial<ExecutorDraft>;
  /** Checks that the model exists, the effort is accepted and tools can be called. Does not call the model. */
  validate(executor: Executor): Promise<ValidationResult>;
}
