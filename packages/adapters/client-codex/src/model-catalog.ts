// SPDX-License-Identifier: MPL-2.0
import {
  AdapterUnavailable,
  PermissionDenied,
  type Executor,
  type ExecutorDraft,
  type ModelCatalog,
  type ModelInfo,
  type ProfileRef,
  type ValidationIssue,
  type ValidationResult,
} from '@otheater/core';
import { CODEX_CONFIG_IDS } from './modes.js';

/** Family of every model of this client, the key of the cross-review (architecture 5.7). */
export const CODEX_FAMILY = 'openai';

/** The part of an ACP `SessionConfigOption` the catalog reads: a select with its values. */
export interface CodexConfigOption {
  readonly id: string;
  readonly category?: string;
  readonly currentValue?: unknown;
  readonly options?: readonly unknown[];
}

/**
 * Where the catalog gets the config options of a profile: those of a `session/new` (Phase 0,
 * `spikes/acp-codex`, item 2) [V]. Core has no ACP, and the package must not start a real client
 * by itself, so the composition root hands in the function that opens a session, reads
 * `configOptions` and closes it.
 */
export type CodexConfigSource = (profile: ProfileRef) => Promise<readonly CodexConfigOption[]>;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The ids of a select option. ACP lists values flat or grouped (`{group, name, options}`). */
function valuesOf(option: CodexConfigOption | undefined): { value: string; name?: string }[] {
  const out: { value: string; name?: string }[] = [];
  const visit = (items: readonly unknown[] | undefined): void => {
    for (const item of items ?? []) {
      const entry = record(item);
      if (entry === undefined) continue;
      if (Array.isArray(entry.options)) {
        visit(entry.options as unknown[]);
        continue;
      }
      if (typeof entry.value !== 'string' || entry.value === '') continue;
      out.push({
        value: entry.value,
        ...(typeof entry.name === 'string' ? { name: entry.name } : {}),
      });
    }
  };
  visit(option?.options);
  return out;
}

/**
 * The models and efforts of one `session/new`. [N] The client lists one effort option for the
 * session, not one per model, so every model gets the same efforts; whether a model refuses one of
 * them only shows when it is used. Nothing here says the model can call tools, so `toolCalls`
 * stays unset.
 */
export function modelsFromConfigOptions(options: readonly CodexConfigOption[]): ModelInfo[] {
  const efforts = valuesOf(options.find((option) => option.id === CODEX_CONFIG_IDS.effort)).map(
    (entry) => entry.value,
  );
  return valuesOf(options.find((option) => option.id === CODEX_CONFIG_IDS.model)).map((entry) => ({
    id: entry.value,
    ...(entry.name === undefined ? {} : { name: entry.name }),
    family: CODEX_FAMILY,
    efforts,
    local: false,
  }));
}

export interface CodexModelCatalogOptions {
  /** Without it, `list` rejects with `AdapterUnavailable`: the catalog is the client's, and a client is not started here. */
  readonly source?: CodexConfigSource;
  /** Effort `suggest` proposes when the model accepts it; the client's own default was `high` in Phase 0. Default `high`. */
  readonly suggestedEffort?: string;
}

/** `ModelCatalog` of `codex-acp`: `automatic`, read from the config options of `session/new`. */
export class CodexModelCatalog implements ModelCatalog {
  readonly discovery = 'automatic';
  readonly #source: CodexConfigSource | undefined;
  readonly #suggestedEffort: string;

  constructor(options: CodexModelCatalogOptions = {}) {
    this.#source = options.source;
    this.#suggestedEffort = options.suggestedEffort ?? 'high';
  }

  async list(profile: ProfileRef): Promise<readonly ModelInfo[]> {
    if (this.#source === undefined) {
      throw new AdapterUnavailable(
        'codex: no config source for the model catalog (it is read from session/new of a real session)',
      );
    }
    return modelsFromConfigOptions(await this.#source(profile));
  }

  suggest(model: ModelInfo): Partial<ExecutorDraft> {
    const effort = model.efforts.includes(this.#suggestedEffort)
      ? this.#suggestedEffort
      : model.efforts[0];
    return {
      family: CODEX_FAMILY,
      local: false,
      ...(effort === undefined ? {} : { effort }),
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      ...(model.cost === undefined ? {} : { cost: model.cost }),
    };
  }

  async validate(executor: Executor): Promise<ValidationResult> {
    const issues: ValidationIssue[] = [];
    if (executor.profile.client !== 'codex') {
      issues.push({
        code: 'profile_invalid',
        severity: 'error',
        message: `the profile ${executor.profile.client}/${executor.profile.profile} is not a codex profile`,
      });
      return { ok: false, issues };
    }
    let models: readonly ModelInfo[];
    try {
      models = await this.list(executor.profile);
    } catch (error) {
      if (error instanceof PermissionDenied) {
        return {
          ok: false,
          issues: [{ code: 'profile_invalid', severity: 'error', message: error.message }],
        };
      }
      throw error;
    }
    const model = models.find((candidate) => candidate.id === executor.model);
    if (model === undefined) {
      issues.push({
        code: 'model_not_found',
        severity: 'error',
        message: `the model ${executor.model} is not in the catalog of ${executor.profile.client}/${executor.profile.profile}`,
      });
    } else if (executor.effort !== undefined && !model.efforts.includes(executor.effort)) {
      issues.push({
        code: 'effort_not_accepted',
        severity: 'error',
        message:
          model.efforts.length === 0
            ? `the model ${model.id} has no effort control`
            : `the model ${model.id} accepts ${model.efforts.join(', ')}, not ${executor.effort}`,
      });
    }
    return { ok: !issues.some((issue) => issue.severity === 'error'), issues };
  }
}
