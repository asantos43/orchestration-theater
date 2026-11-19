// SPDX-License-Identifier: MPL-2.0
import { InvalidInput } from '../errors.js';
import { ROLE_IDS, type RoleId } from '../registries/roles.js';
import { OFFICIAL_CLIENT_OF_PROVIDER, providerOfClient, tryParseExecutorId } from './names.js';
import {
  DEFAULT_ROLE_PRESET,
  DEFAULT_ROLE_REQUIRES,
  ROLE_PRESETS,
  type RolePresetName,
  type RoleRequires,
  type WhenExhausted,
} from './presets.js';

/**
 * The Executors of each role (architecture 5.7; Phase 5, P13): the schema-level rules as pure
 * functions. Nothing here reads a file, the store or a client: the daemon hands in the layers of
 * configuration, the Executors that exist, the profiles and what the models can do, and gets the
 * list of each role back. The pipeline does not read this yet (P16); the old
 * `orchestration.executor` still decides what a play runs.
 */

/** `executors.cross_client` (5.7). */
export const CROSS_CLIENT_MODES = ['api_only', 'off', 'any'] as const;
export type CrossClientMode = (typeof CROSS_CLIENT_MODES)[number];

/** `executors.on_register` (5.7). */
export const ON_REGISTER_MODES = ['ask', 'preset_only', 'none'] as const;
export type OnRegisterMode = (typeof ON_REGISTER_MODES)[number];

/** `roles.capability_check` (5.7). */
export const CAPABILITY_CHECK_MODES = ['warn', 'block', 'off'] as const;
export type CapabilityCheckMode = (typeof CAPABILITY_CHECK_MODES)[number];

/**
 * `roles.preset_scope` [proposta]: what a `preset` given in an override layer does to the lists the
 * layers below it wrote. `all` (default): it replaces them, "troca a base de todos os papéis"
 * (5.7). `unset_roles`: the lists of the layers below survive, and the preset fills only the roles
 * no layer lists.
 */
export const PRESET_SCOPES = ['all', 'unset_roles'] as const;
export type PresetScope = (typeof PRESET_SCOPES)[number];

/**
 * `roles.api_fallback` [proposta]: which API Executors the expansion of a preset appends at the end
 * of each list (5.7, step 3 of the first run). `preset_models` (default): the ones whose
 * `<model>-<effort>` the preset names in some role but the Director (the case of the 5.7 example). `all_registered`:
 * every valid API Executor. `off`: none.
 */
export const API_FALLBACK_MODES = ['preset_models', 'all_registered', 'off'] as const;
export type ApiFallbackMode = (typeof API_FALLBACK_MODES)[number];

/** The keys `roles.<role>` takes besides the policy. */
export interface RoleLayer {
  readonly executors?: readonly string[] | undefined;
  readonly when_exhausted?: WhenExhausted | undefined;
  readonly requires?: RoleRequires | undefined;
}

/** The `roles` block of one layer (the configuration, a scenario override, a scheduled task). */
export type RolesLayer = {
  readonly preset?: RolePresetName | undefined;
  readonly capability_check?: CapabilityCheckMode | undefined;
  readonly allowed_profiles?: readonly string[] | undefined;
  readonly preset_scope?: PresetScope | undefined;
  readonly api_fallback?: ApiFallbackMode | undefined;
} & Partial<Record<RoleId, RoleLayer | undefined>>;

/** An Executor that exists: one `executors.<id>` of the configuration, or one found by a catalog. */
export interface ExecutorEntry {
  /** `<model>-<effort>@<client>/<profile>`. */
  readonly id: string;
  readonly client: string;
  readonly profile: string;
  readonly model: string;
  readonly effort: string | null;
  readonly provider: string;
  /**
   * `executors.<id>.preset_expand` (N136): `false` keeps the Executor out of the expansion of a
   * preset, so it is only in the roles that name it. Absent: `true`.
   */
  readonly presetExpand?: boolean | undefined;
  /** Absent: valid. The store marks one `invalid` when the model is not accepted any more. */
  readonly validity?: 'valid' | 'invalid' | undefined;
  readonly invalidReason?: string | null | undefined;
}

/** What the selection of Executors needs to know about a profile (a `ProfileRecord` fits). */
export interface ProfileFact {
  /** `<client>/<name>`. */
  readonly id: string;
  readonly kind: 'token_plan' | 'api';
  readonly state: 'active' | 'draining' | 'removed';
  /**
   * The account the profile spends, `<client>/<name>` of the profile that owns it, when it is not
   * the profile itself: an OpenCode profile with `codex_link` spends the subscription of its Codex
   * profile (N156). Absent: the profile is its own account.
   */
  readonly account?: string | undefined;
}

/** What a model can do, as a catalog reports it; a missing field is not known and never fails. */
export interface ExecutorCapabilities {
  /** Context window in tokens; for a local model, per slot (5.7). */
  readonly contextWindow?: number | undefined;
  readonly reasoning?: boolean | undefined;
}

/** The old `orchestration.executor` / `orchestration.roles.<role>` (one fixed Executor). */
export interface LegacyExecutor {
  readonly client: string;
  readonly profile: string;
  readonly model: string;
  readonly effort?: string | undefined;
}

export interface ResolveInput {
  /** From the weakest to the strongest: the global `roles`, then the override layers in order. */
  readonly layers: readonly RolesLayer[];
  /** The old format as one Executor per role. It counts as a list of one item of the first layer. */
  readonly legacy?: Readonly<Partial<Record<RoleId, LegacyExecutor>>> | undefined;
  /** The Executors that exist. Order is the tie-break of an expansion. */
  readonly catalog: readonly ExecutorEntry[];
  /** The profiles, in the order the Producer confirmed their accounts. */
  readonly profiles: readonly ProfileFact[];
  readonly capabilities?: ReadonlyMap<string, ExecutorCapabilities> | undefined;
  /** `executors.cross_client`; default `api_only`. */
  readonly crossClient?: CrossClientMode | undefined;
}

export type Shortfall =
  | { readonly kind: 'context'; readonly required: number; readonly actual: number }
  | { readonly kind: 'reasoning' };

/** Where an item of a list came from. */
export type ListOrigin = 'preset' | 'api_fallback' | 'config' | 'legacy';

export interface ResolvedExecutor {
  readonly id: string;
  readonly entry: ExecutorEntry;
  /** `invalid` leaves the selection (5.7): `profile_missing`, `profile_removed`, `not_registered`... */
  readonly validity: 'valid' | 'invalid';
  readonly invalidReason: string | null;
  /** What the role asks and the Executor lacks, kept (`warn`) so the interface marks it. */
  readonly shortfalls: readonly Shortfall[];
  readonly origin: ListOrigin;
}

export interface ResolvedRole {
  readonly role: RoleId;
  readonly executors: readonly ResolvedExecutor[];
  readonly whenExhausted: WhenExhausted;
  readonly requires: RoleRequires;
  /** `preset`: expanded; `config`: a list a layer wrote; `legacy`: the old fixed Executor. */
  readonly source: 'preset' | 'config' | 'legacy';
  /** The layer (index of `ResolveInput.layers`) that wrote the list; null for `preset` and `legacy`. */
  readonly sourceLayer: number | null;
}

export const NOTE_CODES = [
  'no_account',
  'not_registered',
  'invalid_executor',
  'profile_not_allowed',
  'below_minimum',
  'empty_list',
] as const;

export interface ResolveNote {
  readonly severity: 'info' | 'warning';
  readonly code: (typeof NOTE_CODES)[number];
  readonly role: RoleId;
  readonly executorId: string | null;
  readonly message: string;
}

export interface ResolvedRoles {
  readonly preset: RolePresetName;
  readonly capabilityCheck: CapabilityCheckMode;
  /** `roles.allowed_profiles` in force; null: every account. */
  readonly allowedProfiles: readonly string[] | null;
  readonly roles: Readonly<Record<RoleId, ResolvedRole>>;
  readonly notes: readonly ResolveNote[];
}

/** The last layer that says something, and its index. */
function lastOf<K>(
  layers: readonly RolesLayer[],
  pick: (layer: RolesLayer) => K | undefined,
): { value: K; index: number } | undefined {
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    const layer = layers[index];
    const value = layer === undefined ? undefined : pick(layer);
    if (value !== undefined) return { value, index };
  }
  return undefined;
}

/** `<model>-<effort>` of an Executor id: what stands before the `@`. */
function headOf(id: string): string {
  const at = id.indexOf('@');
  return at === -1 ? id : id.slice(0, at);
}

function profileIdOf(entry: Pick<ExecutorEntry, 'client' | 'profile'>): string {
  return `${entry.client}/${entry.profile}`;
}

/** The entry a legacy Executor stands for: its id is the 5.7 name of the fields it carries. */
function legacyEntry(legacy: LegacyExecutor): ExecutorEntry {
  const profileId = `${legacy.client}/${legacy.profile}`;
  const head = legacy.effort === undefined ? legacy.model : `${legacy.model}-${legacy.effort}`;
  return {
    id: `${head}@${profileId}`,
    client: legacy.client,
    profile: legacy.profile,
    model: legacy.model,
    effort: legacy.effort ?? null,
    provider: providerOfClient(legacy.client),
  };
}

/** What each reason of an Executor that is not valid says. */
function reasonText(reason: string): string {
  switch (reason) {
    case 'profile_missing':
      return 'its profile does not exist';
    case 'profile_removed':
      return 'its profile was removed';
    case 'cross_client_refused':
      return 'its model runs outside its official client on a profile that is not an API key (executors.cross_client)';
    case 'not_registered':
      return 'it is not in `executors` and no catalog lists it';
    default:
      return reason;
  }
}

/**
 * Resolves the list of every role from the layers (5.7). Rules:
 * - the effective preset is the last one a layer names (default `quality`);
 * - a role's list is the one of the strongest layer that writes it; then the old fixed Executor of
 *   the role; then the preset expanded over the accounts that exist. A layer that names a `preset`
 *   drops the lists of the layers below it (`preset_scope: all`, the default);
 * - `when_exhausted` and `requires` are per key: the strongest layer that names it, then the
 *   preset (and the minimums of 5.7) as the base;
 * - `allowed_profiles` (the last one given) takes the accounts it does not name out of the lists
 *   after the expansion;
 * - an Executor of a missing or removed profile is `invalid` (it stays in a list somebody wrote);
 *   in an expansion it is left out;
 * - `capability_check`: `block` refuses an Executor below the minimum (throws `InvalidInput` for a
 *   list somebody wrote, drops it from an expansion); `warn` keeps it with its `shortfalls`;
 *   `off` does not look.
 */
export function resolveRoleExecutors(input: ResolveInput): ResolvedRoles {
  const { layers } = input;
  const notes: ResolveNote[] = [];
  const presetPick = lastOf(layers, (layer) => layer.preset);
  const preset = presetPick?.value ?? DEFAULT_ROLE_PRESET;
  const scope = lastOf(layers, (layer) => layer.preset_scope)?.value ?? 'all';
  const cutoff = scope === 'all' ? Math.max(presetPick?.index ?? 0, 0) : 0;
  const capabilityCheck = lastOf(layers, (layer) => layer.capability_check)?.value ?? 'warn';
  const apiFallback = lastOf(layers, (layer) => layer.api_fallback)?.value ?? 'preset_models';
  const allowedProfiles = lastOf(layers, (layer) => layer.allowed_profiles)?.value ?? null;
  const crossClient = input.crossClient ?? 'api_only';

  const profiles = new Map(input.profiles.map((profile) => [profile.id, profile]));
  const accountOrder = new Map(input.profiles.map((profile, index) => [profile.id, index]));
  const catalog = new Map(input.catalog.map((entry) => [entry.id, entry]));

  /** Why an Executor is not valid, or null. */
  const invalidReasonOf = (entry: ExecutorEntry): string | null => {
    if (entry.validity === 'invalid') return entry.invalidReason ?? 'invalid';
    const profile = profiles.get(profileIdOf(entry));
    if (profile === undefined) return 'profile_missing';
    if (profile.state === 'removed') return 'profile_removed';
    const official = OFFICIAL_CLIENT_OF_PROVIDER[entry.provider];
    if (official !== undefined && official !== entry.client) {
      if (crossClient === 'off' || (crossClient === 'api_only' && profile.kind !== 'api')) {
        return 'cross_client_refused';
      }
    }
    return null;
  };

  const shortfallsOf = (entry: ExecutorEntry, requires: RoleRequires): Shortfall[] => {
    const capabilities = input.capabilities?.get(entry.id);
    const out: Shortfall[] = [];
    if (
      requires.context !== undefined &&
      capabilities?.contextWindow !== undefined &&
      capabilities.contextWindow < requires.context
    ) {
      out.push({ kind: 'context', required: requires.context, actual: capabilities.contextWindow });
    }
    if (requires.reasoning === true && capabilities?.reasoning === false) {
      out.push({ kind: 'reasoning' });
    }
    return out;
  };

  const officialFirst = (a: ExecutorEntry, b: ExecutorEntry): number => {
    const rank = (entry: ExecutorEntry): number =>
      OFFICIAL_CLIENT_OF_PROVIDER[entry.provider] === entry.client ? 0 : 1;
    return (
      rank(a) - rank(b) ||
      (accountOrder.get(profileIdOf(a)) ?? Number.MAX_SAFE_INTEGER) -
        (accountOrder.get(profileIdOf(b)) ?? Number.MAX_SAFE_INTEGER) ||
      a.id.localeCompare(b.id)
    );
  };

  const usable = (entry: ExecutorEntry): boolean => invalidReasonOf(entry) === null;
  // `preset_expand: false` (N136) takes the Executor out of every expansion: it stays in a list
  // somebody wrote that names it.
  const expandable = (entry: ExecutorEntry): boolean => entry.presetExpand !== false;
  // The Director's model is a cheap router, not a fallback for the roles that write or judge.
  const presetHeads = new Set(
    ROLE_IDS.filter((role) => role !== 'director').flatMap(
      (role) => ROLE_PRESETS[preset][role].heads,
    ),
  );

  const apiEntries = input.catalog
    .filter(
      (entry) =>
        usable(entry) && expandable(entry) && profiles.get(profileIdOf(entry))?.kind === 'api',
    )
    .filter((entry) => apiFallback === 'all_registered' || presetHeads.has(headOf(entry.id)))
    .sort(officialFirst);

  const roles = {} as Record<RoleId, ResolvedRole>;

  for (const role of ROLE_IDS) {
    // The base of this role: what the strongest layer names, else the old format, else the preset.
    let explicit: { ids: readonly string[]; index: number } | undefined;
    for (let index = layers.length - 1; index >= cutoff; index -= 1) {
      const ids = layers[index]?.[role]?.executors;
      if (ids !== undefined) {
        explicit = { ids, index };
        break;
      }
    }
    const legacy = explicit === undefined && cutoff === 0 ? input.legacy?.[role] : undefined;

    const requires = layers.reduce<RoleRequires>((acc, layer) => {
      const given = layer[role]?.requires;
      return {
        ...acc,
        ...(given?.context !== undefined && { context: given.context }),
        ...(given?.reasoning !== undefined && { reasoning: given.reasoning }),
      };
    }, DEFAULT_ROLE_REQUIRES[role]);
    const whenExhausted =
      lastOf(layers, (layer) => layer[role]?.when_exhausted)?.value ??
      ROLE_PRESETS[preset][role].whenExhausted;

    const source: ResolvedRole['source'] =
      explicit !== undefined ? 'config' : legacy !== undefined ? 'legacy' : 'preset';
    const fromPreset = source === 'preset';

    // 1. The candidates, with where each came from.
    const items: ResolvedExecutor[] = [];
    const push = (entry: ExecutorEntry, origin: ListOrigin, reason: string | null): void => {
      if (items.some((item) => item.id === entry.id)) return;
      items.push({
        id: entry.id,
        entry,
        validity: reason === null ? 'valid' : 'invalid',
        invalidReason: reason,
        shortfalls: [],
        origin,
      });
    };

    if (explicit !== undefined) {
      for (const id of explicit.ids) {
        const known = catalog.get(id);
        if (known !== undefined) {
          push(known, 'config', invalidReasonOf(known));
          continue;
        }
        const parsed = tryParseExecutorId(id);
        if (typeof parsed === 'string') {
          throw new InvalidInput(`roles.${role}.executors: ${parsed}`);
        }
        // Named but not registered: the name does not carry the model id the client takes.
        notes.push({
          severity: 'warning',
          code: 'not_registered',
          role,
          executorId: id,
          message: `roles.${role}.executors: "${id}" is not in executors and no catalog lists it; it stays out of the selection`,
        });
        push(
          {
            id,
            client: parsed.client,
            profile: parsed.profile,
            model: parsed.model,
            effort: parsed.effort,
            provider: providerOfClient(parsed.client),
          },
          'config',
          'not_registered',
        );
      }
    } else if (legacy !== undefined) {
      const entry = legacyEntry(legacy);
      push(entry, 'legacy', invalidReasonOf(entry));
    } else {
      for (const head of ROLE_PRESETS[preset][role].heads) {
        const named = input.catalog.filter((entry) => headOf(entry.id) === head && usable(entry));
        const candidates = named.filter(expandable).sort(officialFirst);
        if (candidates.length === 0) {
          notes.push({
            severity: 'info',
            code: 'no_account',
            role,
            executorId: null,
            message:
              named.length > 0
                ? `roles.${role}: preset "${preset}" names "${head}" and every account that has it is set to preset_expand: false; it is left out`
                : `roles.${role}: preset "${preset}" names "${head}" and no account of this machine has it; it is left out`,
          });
        }
        for (const entry of candidates) push(entry, 'preset', null);
      }
      if (apiFallback !== 'off') {
        for (const entry of apiEntries) push(entry, 'api_fallback', null);
      }
    }

    // 2. `roles.allowed_profiles`: after the expansion, only restricts.
    const allowed = allowedProfiles === null ? null : new Set(allowedProfiles);
    let kept = items.filter((item) => {
      if (allowed === null || allowed.has(profileIdOf(item.entry))) return true;
      notes.push({
        severity: 'info',
        code: 'profile_not_allowed',
        role,
        executorId: item.id,
        message: `roles.${role}: "${item.id}" is left out: its profile is not in roles.allowed_profiles`,
      });
      return false;
    });

    // 3. The minimum of the role.
    if (capabilityCheck !== 'off') {
      kept = kept.flatMap((item) => {
        if (item.validity === 'invalid') return [item];
        const shortfalls = shortfallsOf(item.entry, requires);
        if (shortfalls.length === 0) return [item];
        const why = shortfalls
          .map((s) =>
            s.kind === 'context'
              ? `context ${String(s.actual)} < ${String(s.required)}`
              : 'no reasoning',
          )
          .join(', ');
        if (capabilityCheck === 'block') {
          if (!fromPreset) {
            throw new InvalidInput(
              `roles.${role}.executors: "${item.id}" is below the minimum of the role (${why}) and roles.capability_check is "block"`,
            );
          }
          notes.push({
            severity: 'info',
            code: 'below_minimum',
            role,
            executorId: item.id,
            message: `roles.${role}: "${item.id}" is left out of the preset: below the minimum of the role (${why})`,
          });
          return [];
        }
        notes.push({
          severity: 'warning',
          code: 'below_minimum',
          role,
          executorId: item.id,
          message: `roles.${role}: "${item.id}" is below the minimum of the role (${why}); kept marked (roles.capability_check: warn)`,
        });
        return [{ ...item, shortfalls }];
      });
    }

    for (const item of kept) {
      if (item.validity === 'invalid' && item.invalidReason !== 'not_registered') {
        notes.push({
          severity: 'warning',
          code: 'invalid_executor',
          role,
          executorId: item.id,
          message: `roles.${role}: "${item.id}" is invalid: ${reasonText(item.invalidReason ?? 'invalid')}`,
        });
      }
    }
    if (kept.length === 0) {
      notes.push({
        severity: 'warning',
        code: 'empty_list',
        role,
        executorId: null,
        message: `roles.${role}: no Executor is left in the list; the role falls back to when_exhausted: ${whenExhausted}`,
      });
    }

    roles[role] = {
      role,
      executors: kept,
      whenExhausted,
      requires,
      source,
      sourceLayer: explicit?.index ?? null,
    };
  }

  return { preset, capabilityCheck, allowedProfiles, roles, notes };
}

/** One place an Executor may go (5.7, `executors.on_register`). */
export interface RegistrationPlacement {
  readonly role: RoleId;
  /** Where in the current list of the role it goes (0 is the first). */
  readonly position: number;
  /** The preset of the role names the Executor's `<model>-<effort>`. */
  readonly preselected: boolean;
}

export interface RegistrationPlan {
  readonly mode: OnRegisterMode;
  /** What the daemon puts in the lists with no question (`preset_only`). */
  readonly apply: readonly RegistrationPlacement[];
  /** What the assistant offers (`ask`): every role, the preset ones marked. */
  readonly options: readonly RegistrationPlacement[];
}

/**
 * What `executors.on_register` does with a new Executor (5.7), with no I/O: `ask` returns every
 * role as an option, the ones whose preset (`preset`) names the Executor's `<model>-<effort>`
 * preselected; `preset_only` applies the preselected ones at the position the preset gives; `none`
 * does nothing. `currentLists` are the Executor ids now in each list, to find the position.
 */
export function planRegistration(input: {
  readonly executorId: string;
  readonly mode: OnRegisterMode;
  readonly preset: RolePresetName;
  readonly currentLists?: Readonly<Partial<Record<RoleId, readonly string[]>>> | undefined;
}): RegistrationPlan {
  const head = headOf(input.executorId);
  const options: RegistrationPlacement[] = ROLE_IDS.map((role) => {
    const heads = ROLE_PRESETS[input.preset][role].heads;
    const own = heads.indexOf(head);
    const current = input.currentLists?.[role] ?? [];
    if (own === -1) return { role, position: current.length, preselected: false };
    // After the last item whose head the preset puts before this one.
    let position = 0;
    current.forEach((id, index) => {
      const rank = heads.indexOf(headOf(id));
      if (rank !== -1 && rank < own) position = index + 1;
    });
    return { role, position, preselected: true };
  });
  if (input.mode === 'none') return { mode: input.mode, apply: [], options: [] };
  if (input.mode === 'preset_only') {
    return {
      mode: input.mode,
      apply: options.filter((option) => option.preselected),
      options: [],
    };
  }
  return { mode: input.mode, apply: [], options };
}
