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
}

/**
 * The heads of the preset the models listed for one account fill (N324: also the marks of the list
 * of models after a login). Nothing for a client whose models the preset does not name.
 */
export function matchPreset(input: MatchPresetInput): DiscoverResult {
  const discovered: SetupExecutor[] = [];
  const notes: SetupNote[] = [];
  const { profileId, listed } = input;
  const ref = parseProfileId(profileId);
  const prefix = HEAD_PREFIX_OF_CLIENT[ref.client];
  const provider = FIXED_PROVIDER_OF_CLIENT[ref.client];
  if (prefix === undefined || provider === undefined) return { discovered, notes };
  for (const head of presetHeads(input.preset)) {
    const split = splitHead(head);
    if (typeof split === 'string' || !split.model.startsWith(`${prefix}-`)) continue;
    const short = split.model.slice(prefix.length + 1);
    const info = listed.find((candidate) => matches(candidate, short));
    if (info === undefined) continue;
    if (split.effort !== null && info.efforts.length > 0 && !info.efforts.includes(split.effort)) {
      notes.push({
        severity: 'warning',
        code: 'effort_not_accepted',
        role: null,
        message: `${profileId}: the model ${info.id} does not accept the effort "${split.effort}" the preset names; it is left out`,
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
