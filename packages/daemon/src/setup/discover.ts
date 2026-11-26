// SPDX-License-Identifier: MPL-2.0
import {
  FIXED_PROVIDER_OF_CLIENT,
  ROLE_IDS,
  ROLE_PRESETS,
  formatExecutorId,
  parseProfileId,
  splitHead,
  type ModelCatalog,
  type ModelInfo,
  type RolePresetName,
} from '@otheater/core';
import type { SetupExecutor, SetupNote } from '@otheater/protocol';
import type { DaemonConfig, PresetMatchMode } from '../config.js';
import { aliasOfModel } from '../executors/service.js';

/**
 * What the catalogs of the official clients give for a preset (architecture 5.7, "Primeira
 * execução", step 3). [proposta] The preset names models by a head (`claude-opus-high`); the
 * catalog of Claude Code or Codex lists the models its account can use. For each confirmed account
 * of one of those clients, a head whose model the catalog lists becomes an Executor to write. The
 * ones the catalogs do not list (OpenCode, MiniMax, a local model) come through the `executors`
 * step. Nothing is called on the model: a catalog lists, it does not run.
 */

/** The word a preset puts before the name of a model of each official client. */
const HEAD_PREFIX_OF_CLIENT: Readonly<Record<string, string>> = {
  'claude-code': 'claude',
  codex: 'codex',
};

export interface DiscoverInput {
  /** The accounts that take part (`<client>/<profile>`), in order. */
  readonly accounts: readonly string[];
  readonly preset: RolePresetName;
  /** The catalog of a client, or `undefined` when it is not installed. */
  readonly catalogs: (client: string) => ModelCatalog | undefined;
  /** `executors.on_register` is `none` (N136): what is found stays out of the expansion of a preset. */
  readonly presetExpand: boolean;
  /** How a model of the preset finds its model in the catalog (N333). Default: newest, no table. */
  readonly match?: PresetMatch;
}

/**
 * How a model of a preset (`codex-sol`) finds the model a catalog lists (N333, 2026-11-26).
 * - `aliases` (`executors.aliases`): the model of the preset to the id the catalog lists
 *   (`codex-sol: gpt-6.2-sol`). It comes first, in both modes.
 * - `mode` `newest` (default) [proposta]: an id equal to the family (`sol`) comes next; else the
 *   newest listed id that has the family as a word (`gpt-6.2-sol` before `gpt-5.6-sol`), by the
 *   numbers of its name, among the ones that accept the effort of the head. `exact`: only an id
 *   equal to the family (the rule before N333).
 */
export interface PresetMatch {
  readonly mode: PresetMatchMode;
  readonly aliases: Readonly<Record<string, string>>;
}

export const DEFAULT_PRESET_MATCH: PresetMatch = { mode: 'newest', aliases: {} };

/** The {@link PresetMatch} of a configuration: `setup.preset_match` and `executors.aliases`. */
export function presetMatchOf(config: DaemonConfig): PresetMatch {
  return { mode: config.setup.preset_match, aliases: config.executors.aliases };
}

export interface DiscoverResult {
  readonly discovered: SetupExecutor[];
  readonly notes: SetupNote[];
}

/** The heads of the preset, each once, in the order the roles name them. */
export function presetHeads(preset: RolePresetName): string[] {
  const heads: string[] = [];
  for (const role of ROLE_IDS) {
    for (const head of ROLE_PRESETS[preset][role].heads) {
      if (!heads.includes(head)) heads.push(head);
    }
  }
  return heads;
}

function matches(info: ModelInfo, short: string): boolean {
  return (
    aliasOfModel(info.id) === short ||
    (info.name !== undefined && aliasOfModel(info.name) === short)
  );
}

/** The words of a model id (`gpt-6.2-sol` → `gpt`, `6.2`, `sol`). */
function wordsOf(text: string): string[] {
  return aliasOfModel(text)
    .split(/[-_]+/)
    .filter((word) => word !== '');
}

/** The family is in the id as whole words, in order (`sol` in `gpt-6.2-sol`, not in `solar`). */
function hasFamily(info: ModelInfo, short: string): boolean {
  const family = wordsOf(short);
  if (family.length === 0) return false;
  const inText = (text: string): boolean => {
    const words = wordsOf(text);
    for (let start = 0; start + family.length <= words.length; start += 1) {
      if (family.every((word, index) => words[start + index] === word)) return true;
    }
    return false;
  };
  return inText(info.id) || (info.name !== undefined && inText(info.name));
}

/** The numbers of a model id, in order (`gpt-6.2-sol` → 6, 2): its version. */
function versionOf(id: string): number[] {
  return (aliasOfModel(id).match(/\d+/g) ?? []).map(Number);
}

/** Newest first: the larger version, then the shorter id (`gpt-6.2-sol` before `gpt-6.2-sol-mini`). */
function newestFirst(a: ModelInfo, b: ModelInfo): number {
  const va = versionOf(a.id);
  const vb = versionOf(b.id);
  for (let index = 0; index < Math.max(va.length, vb.length); index += 1) {
    const diff = (vb[index] ?? -1) - (va[index] ?? -1);
    if (diff !== 0) return diff;
  }
  return a.id.length - b.id.length || a.id.localeCompare(b.id);
}

function acceptsEffort(info: ModelInfo, effort: string | null): boolean {
  return effort === null || info.efforts.length === 0 || info.efforts.includes(effort);
}

interface Candidates {
  /** The listed models that may fill the head, best first. */
  readonly models: ModelInfo[];
  /** `executors.aliases` names a model the catalog does not list. */
  readonly aliasMissing: string | null;
}

function candidatesFor(
  listed: readonly ModelInfo[],
  model: string,
  short: string,
  effort: string | null,
  match: PresetMatch,
): Candidates {
  const aliased = match.aliases[model];
  if (aliased !== undefined) {
    const info = listed.find(
      (candidate) =>
        candidate.id === aliased || aliasOfModel(candidate.id) === aliasOfModel(aliased),
    );
    if (info !== undefined) return { models: [info], aliasMissing: null };
  }
  const aliasMissing = aliased ?? null;
  const exact = listed.filter((candidate) => matches(candidate, short));
  if (match.mode === 'exact' || exact.length > 0) return { models: exact, aliasMissing };
  const family = listed
    .filter((candidate) => !candidate.local && hasFamily(candidate, short))
    .sort(newestFirst);
  // The newest that takes the effort; when none does, the newest, for the note.
  const fit = family.filter((candidate) => acceptsEffort(candidate, effort));
  return { models: fit.length > 0 ? fit : family, aliasMissing };
}

export async function discoverForPreset(input: DiscoverInput): Promise<DiscoverResult> {
  const discovered: SetupExecutor[] = [];
  const notes: SetupNote[] = [];
  for (const profileId of input.accounts) {
    const ref = parseProfileId(profileId);
    if (HEAD_PREFIX_OF_CLIENT[ref.client] === undefined) continue;
    if (FIXED_PROVIDER_OF_CLIENT[ref.client] === undefined) continue;
    const catalog = input.catalogs(ref.client);
    if (catalog?.discovery !== 'automatic') continue;
    let listed: readonly ModelInfo[];
    try {
      listed = await catalog.list(ref);
    } catch (error) {
      notes.push({
        severity: 'warning',
        code: 'catalog_unavailable',
        role: null,
        profileId,
        message: `the model catalog of ${profileId} could not be read (${
          error instanceof Error ? error.message : String(error)
        }); its models are not proposed`,
      });
      continue;
    }
    const found = matchPreset({
      profileId,
      listed,
      preset: input.preset,
      presetExpand: input.presetExpand,
      ...(input.match === undefined ? {} : { match: input.match }),
    });
    discovered.push(...found.discovered);
    notes.push(...found.notes);
  }
  return { discovered, notes };
}

export interface MatchPresetInput {
  readonly profileId: string;
  /** What the catalog of the account listed. */
  readonly listed: readonly ModelInfo[];
  readonly preset: RolePresetName;
  readonly presetExpand: boolean;
  readonly match?: PresetMatch;
}

/**
 * The heads of the preset the models listed for one account fill (N324: also the marks of the list
 * of models after a login). Nothing for a client whose models the preset does not name. The
 * Executor keeps the name of the preset (`codex-sol-high@codex/main`, N333) and the listed id as
 * its model (`gpt-6.2-sol`).
 */
export function matchPreset(input: MatchPresetInput): DiscoverResult {
  const discovered: SetupExecutor[] = [];
  const notes: SetupNote[] = [];
  const { profileId, listed } = input;
  const ref = parseProfileId(profileId);
  const prefix = HEAD_PREFIX_OF_CLIENT[ref.client];
  const provider = FIXED_PROVIDER_OF_CLIENT[ref.client];
  if (prefix === undefined || provider === undefined) return { discovered, notes };
  const match = input.match ?? DEFAULT_PRESET_MATCH;
  const warnedAliases = new Set<string>();
  for (const head of presetHeads(input.preset)) {
    const split = splitHead(head);
    if (typeof split === 'string' || !split.model.startsWith(`${prefix}-`)) continue;
    const short = split.model.slice(prefix.length + 1);
    const found = candidatesFor(listed, split.model, short, split.effort, match);
    if (found.aliasMissing !== null && !warnedAliases.has(split.model)) {
      warnedAliases.add(split.model);
      notes.push({
        severity: 'warning',
        code: 'alias_not_listed',
        role: null,
        head,
        profileId,
        message: `${profileId}: executors.aliases names ${found.aliasMissing} for ${split.model}, but the catalog does not list it; the rule of setup.preset_match is used`,
      });
    }
    const info = found.models[0];
    if (info === undefined) continue;
    if (!acceptsEffort(info, split.effort)) {
      notes.push({
        severity: 'warning',
        code: 'effort_not_accepted',
        role: null,
        head,
        profileId,
        message: `${profileId}: the model ${info.id} does not accept the effort "${String(split.effort)}" the preset names; it is left out`,
      });
      continue;
    }
    discovered.push({
      id: formatExecutorId({ model: split.model, effort: split.effort, profileId }),
      profileId,
      model: info.id,
      alias: split.model,
      effort: split.effort,
      provider,
      source: 'discovered',
      presetExpand: input.presetExpand,
      local: null,
    });
  }
  return { discovered, notes };
}
