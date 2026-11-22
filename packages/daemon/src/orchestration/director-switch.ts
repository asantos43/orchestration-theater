// SPDX-License-Identifier: MPL-2.0
import type { JsonObject, JsonValue, ResolvedExecutor } from '@otheater/core';
import type { DirectorSwitchForm } from '@otheater/protocol';

/**
 * The manual switch of the Director (Phase 9, P14, owner's decision N242): the pieces that do not
 * need a session. The override lives in the `configOverride` of the scenario, under one key of its
 * own, so it is kept in the store (it survives the sleep of the Director and a restart of the
 * daemon) and goes away only when the Producer asks for the default.
 */

/** The key of the `configOverride` of the scenario that holds the override of the Director [proposta]. */
export const DIRECTOR_OVERRIDE_KEY = 'director_override';

/**
 * What the Producer chose for the Director of a scenario. `executor` is always an Executor of the
 * list of the `director` role (complete name); `model` and `effort` replace the ones of that entry
 * and are present only when the Producer changed them.
 */
export interface DirectorOverride {
  readonly executor: string;
  readonly model?: string;
  readonly effort?: string;
}

function isPlain(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The override of a scenario, or `null` when there is none (or what is there is not one). */
export function readDirectorOverride(configOverride: JsonObject): DirectorOverride | null {
  const raw = configOverride[DIRECTOR_OVERRIDE_KEY];
  if (!isPlain(raw)) return null;
  const { executor, model, effort } = raw;
  if (typeof executor !== 'string' || executor === '') return null;
  return {
    executor,
    ...(typeof model === 'string' && model !== '' ? { model } : {}),
    ...(typeof effort === 'string' && effort !== '' ? { effort } : {}),
  };
}

/** The `configOverride` with the override set (or removed, with `null`); the other keys are kept. */
export function writeDirectorOverride(
  configOverride: JsonObject,
  override: DirectorOverride | null,
): JsonObject {
  const rest = Object.fromEntries(
    Object.entries(configOverride).filter(([key]) => key !== DIRECTOR_OVERRIDE_KEY),
  );
  return override === null ? rest : { ...rest, [DIRECTOR_OVERRIDE_KEY]: { ...override } };
}

/** A string that is equal for two equal overrides: what a session compares to know it is stale. */
export function directorOverrideKey(override: DirectorOverride | null): string {
  return override === null
    ? ''
    : JSON.stringify([override.executor, override.model ?? null, override.effort ?? null]);
}

/** What the Producer asks: the default, or a choice of Executor, model and effort. */
export type DirectorSwitchChange =
  | { readonly kind: 'default' }
  | {
      readonly kind: 'set';
      /** An Executor of the list: complete name, its position (1-based) or a prefix. */
      readonly executor?: string | undefined;
      readonly model?: string | undefined;
      readonly effort?: string | undefined;
    };

/**
 * The Executor of the list a text names: the complete name, the position in the list as `/director`
 * shows it (1-based) or a prefix of one name. `undefined` when none; `ambiguous` when several.
 */
export function matchExecutor(
  list: readonly ResolvedExecutor[],
  text: string,
): ResolvedExecutor | 'ambiguous' | undefined {
  const wanted = text.trim();
  if (wanted === '') return undefined;
  const exact = list.find((item) => item.id === wanted);
  if (exact !== undefined) return exact;
  if (/^[1-9][0-9]*$/.test(wanted)) return list[Number(wanted) - 1];
  const prefixed = list.filter((item) => item.id.startsWith(wanted));
  if (prefixed.length === 1) return prefixed[0];
  return prefixed.length === 0 ? undefined : 'ambiguous';
}

/** One Executor of the list of the role, as the picker and `/director` show it. */
export interface DirectorViewExecutor {
  /** Position in the list, from 1. */
  readonly index: number;
  readonly id: string;
  readonly client: string;
  readonly profile: string;
  readonly model: string;
  readonly effort: string | null;
  readonly validity: 'valid' | 'invalid';
  readonly invalidReason: string | null;
  /** The quota state of its profile (`ok`, `near_limit`, `exhausted`, `unknown`...); null when not read. */
  readonly quota: string | null;
  /** When the quota is due back (epoch ms), if a source says. */
  readonly quotaResetsAt: number | null;
  /** The Director runs with this one now (or would, when it sleeps). */
  readonly current: boolean;
  /** The first valid one: what the Director goes by without an override. */
  readonly isDefault: boolean;
}

/** A model the client announces, with the efforts it takes. */
export interface DirectorViewModel {
  readonly id: string;
  readonly name: string | null;
  readonly efforts: readonly string[];
}

/** The state of the Director of a scenario for the footer and the picker (P14). */
export interface DirectorView {
  readonly scenarioId: string;
  /** `open`: a session is open; `asleep`: it sleeps; `opening`: it is opening or waits for an Executor; `none`: not opened yet. */
  readonly session: 'open' | 'asleep' | 'opening' | 'none';
  /** A turn is running or a prompt is about to be delivered. */
  readonly inTurn: boolean;
  /** A switch waits for the end of the turn. */
  readonly pending: boolean;
  /** What the Director runs with (or would): the Executor, the model and the effort in force. */
  readonly current: {
    readonly executor: string;
    readonly client: string;
    readonly profile: string;
    readonly model: string;
    readonly effort: string | null;
  } | null;
  readonly override: DirectorOverride | null;
  /** The Executor the Director goes by without an override. */
  readonly default: string | null;
  readonly executors: readonly DirectorViewExecutor[];
  /** The models of the current profile, as the client announces them; empty when it does not say. */
  readonly models: readonly DirectorViewModel[];
  /** The efforts the current model takes (or all that the client announces). */
  readonly efforts: readonly string[];
  /** `scenarios.director_switch.in_turn`. */
  readonly inTurnMode: 'wait' | 'interrupt';
}

/** What a switch did, for the command and the notice. */
export interface DirectorSwitchResult {
  /** `pending`: the Director is in a turn and the switch waits for its end. */
  readonly status: 'applied' | 'pending';
  /** The form used; `null` while `pending` (it is told when the turn ends). */
  readonly form: DirectorSwitchForm | null;
  readonly override: DirectorOverride | null;
  readonly view: DirectorView;
}

/** What the Director runs with, as the switch notices and the footer write it: Executor, model, effort. */
export function directorWhat(
  executor: string | null,
  model: string | null,
  effort: string | null,
): string {
  const settings = [model, effort].filter((item): item is string => item !== null).join(' / ');
  return `${executor ?? '-'}${settings === '' ? '' : ` [${settings}]`}`;
}
