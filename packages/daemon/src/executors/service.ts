// SPDX-License-Identifier: MPL-2.0
import {
  AdapterUnavailable,
  Conflict,
  DEFAULT_ROLE_PRESET,
  DEFAULT_ROLE_REQUIRES,
  EFFORT_LEVELS,
  FIXED_PROVIDER_OF_CLIENT,
  InvalidInput,
  NotFound,
  ROLE_IDS,
  Transient,
  formatExecutorId,
  isOTheaterError,
  parseProfileId,
  planRegistration,
  resolveRoleExecutors,
  tryParseExecutorId,
  type Clock,
  type ExecutorEntry,
  type ExecutorRecord,
  type ModelCatalog,
  type ModelCost,
  type ModelInfo,
  type OnRegisterMode,
  type ProfileFact,
  type ProfileRecord,
  type RegistrationPlacement,
  type RoleId,
  type RoleRequires,
  type Store,
} from '@otheater/core';
import { LocalConfigSchema, type LocalConfig } from '@otheater/protocol';
import { editConfigFile } from '../config-edit.js';
import { loadConfig, type DaemonConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { writeSituation } from '../situations.js';
import type { TestSession, TestSessionResult } from './test-session.js';

/**
 * The cadastro of the Executors (architecture 5.7, "Cadastro"; Phase 5, P14): the model comes from
 * the catalog of the client of the profile, the fields come pre-filled from `suggest`, the model
 * is validated (and, when asked, run in a short test session), and the Executor is written to
 * `executors.<id>` of the configuration, to the `executors` table and, per `executors.on_register`,
 * to the lists of the roles. There is no screen (N121): the logic is here and `ot executor` is its
 * only face; the Producer's setup assistant will call the same methods.
 *
 * The configuration file is the Producer's. A command edits it only by the keys it owns
 * (`config-edit.ts` keeps the comments and validates the result before writing).
 */

/** Where a model may be told apart from the others: the catalog id is the real model id. */
export interface ExecutorServiceOptions {
  readonly store: Store;
  readonly clock: Clock;
  readonly logger: Logger;
  /** `<data>/config.yaml`. */
  readonly configPath: string;
  /** The model catalog of a client, or `undefined` when the client is not installed. */
  readonly catalogs: (client: string) => ModelCatalog | undefined;
  /**
   * Runs the short test session (5.7, step 4). `undefined`: there is no way to run one here (an
   * `ot` command with no daemon has no execution), and `executors.test_session: run` only warns.
   */
  readonly testSession?: TestSession | undefined;
}

/** Why a field is not settled or a check did not pass. */
export interface RegisterIssue {
  readonly code: string;
  /** `error` stops the cadastro; `warning` goes on and is reported; `info` is only reported. */
  readonly severity: 'error' | 'warning' | 'info';
  readonly message: string;
}

/** A field the Producer must give before the Executor can be registered. */
export type MissingField = 'family' | 'alias' | 'local_url';

/** A role placement the Producer asks for (`--role author[:position]`). */
export interface RolePlacementInput {
  readonly role: RoleId;
  /** 0 is the first of the list; absent: the end. */
  readonly position?: number | undefined;
}

export interface AddExecutorInput {
  /** `<client>/<profile>`. */
  readonly profileId: string;
  /** The model id as the catalog lists it (`minimax/MiniMax-M2`). */
  readonly model: string;
  /** `low`, `medium` or `high`; absent: what the catalog suggests. */
  readonly effort?: string | undefined;
  /** The family (the provider of the Executor) of a model whose client does not fix it. */
  readonly family?: string | undefined;
  /** The name of the model inside the Executor id (`<alias>-<effort>@...`); absent: derived. */
  readonly alias?: string | undefined;
  /** URL of the local server, when the catalog does not give it (or to correct it). */
  readonly localUrl?: string | undefined;
  readonly localServer?: LocalConfig['server'] | undefined;
  /** Explicit placements in the lists of the roles, whatever `executors.on_register` says. */
  readonly roles?: readonly RolePlacementInput[] | undefined;
  /** Overrides `executors.test_session` for this cadastro. */
  readonly testSession?: 'run' | 'off' | undefined;
  /** Compute and report everything, write nothing. */
  readonly dryRun?: boolean | undefined;
}

/** What the cadastro filled in, for the Producer to confirm or correct. */
export interface ExecutorDraftView {
  /** The Executor id the fields give (`minimax-m2-medium@opencode/local`), when it can be formed. */
  readonly id: string | null;
  /** The model id in the catalog. */
  readonly model: string;
  readonly alias: string | null;
  readonly effort: string | null;
  /** The efforts the catalog offers for the model, in its own ids. */
  readonly efforts: readonly string[];
  /** Blank (null) while a client that does not fix it has no family to give. */
  readonly provider: string | null;
  readonly local: boolean;
  readonly contextWindow: number | null;
  readonly reasoning: boolean | null;
  readonly toolCalls: boolean | null;
  /** Price per million tokens as the catalog gives it; the cadastro does not store it (`pricing` is P10). */
  readonly cost: ModelCost | null;
}

export interface ExecutorView {
  readonly id: string;
  readonly profileId: string;
  readonly client: string;
  readonly profile: string;
  /** The model id the client takes (the catalog id); the alias is in the id. */
  readonly model: string;
  readonly effort: string | null;
  readonly provider: string;
  readonly validity: 'valid' | 'invalid';
  readonly invalidReason: string | null;
  /** Written in `executors.<id>` of the configuration. */
  readonly configured: boolean;
  /** The roles whose list holds it now. */
  readonly roles: readonly RoleId[];
}

export interface PlacementReport {
  readonly role: RoleId;
  /** `list`: written in `roles.<role>.executors`; `preset`: it comes from the preset of the role. */
  readonly via: 'list' | 'preset';
  readonly position: number;
  /** The role holds the Executor after the cadastro. */
  readonly inList: boolean;
}

export type AddExecutorResult =
  | {
      readonly status: 'registered' | 'dry_run';
      readonly executor: ExecutorView;
      readonly draft: ExecutorDraftView;
      readonly issues: readonly RegisterIssue[];
      readonly placements: readonly PlacementReport[];
      /** `ask`: the roles the Executor may be put in (the preset ones marked); nothing was placed. */
      readonly options: readonly RegistrationPlacement[];
      readonly onRegister: OnRegisterMode;
      /** `created`: `profiles.<id>.local` was written; `kept`: it already existed; `none`. */
      readonly localBlock: 'created' | 'kept' | 'none';
      /** `skipped`: not asked or no way to run; `approved` / `failed`: the session ran. */
      readonly testSession: 'skipped' | 'approved' | 'failed';
      /** The price the catalog gave, exposed for the Producer (and for `pricing`, P10). */
      readonly cost: ModelCost | null;
      /** The body of `executors.<id>`: what the cadastro writes (and what the setup assistant writes later). */
      readonly configEntry: ExecutorConfigEntry;
      /** The `profiles.<id>.local` block the cadastro writes; `null` when it writes none. */
      readonly localConfig: Pick<LocalConfig, 'server' | 'url'> | null;
    }
  | {
      /** A field is missing: the Producer gives it and runs the command again. */
      readonly status: 'needs_input';
      readonly missing: readonly MissingField[];
      readonly draft: ExecutorDraftView;
      readonly issues: readonly RegisterIssue[];
    }
  | {
      readonly status: 'refused';
      readonly draft: ExecutorDraftView | null;
      readonly issues: readonly RegisterIssue[];
    };

export interface CheckedExecutor {
  readonly id: string;
  readonly validity: 'valid' | 'invalid' | 'unchecked';
  readonly reason: string | null;
  readonly issues: readonly RegisterIssue[];
  /** The row of the table changed. */
  readonly changed: boolean;
}

export interface RemoveExecutorResult {
  readonly id: string;
  /** The roles whose list had it and no longer has. */
  readonly rolesChanged: readonly RoleId[];
  /** The roles whose list became empty and was taken out (they fall back to the preset). */
  readonly rolesEmptied: readonly RoleId[];
  readonly inConfig: boolean;
}

/** The reason of an `invalid` row for each code the catalog answers with. */
const REASON_OF_CODE: Readonly<Record<string, string>> = {
  model_not_found: 'model_unknown',
  effort_not_accepted: 'effort_unknown',
  no_tool_calls: 'no_tool_calls',
  context_too_small: 'context_too_small',
  profile_invalid: 'profile_invalid',
};

/** `removed` is what `remove` writes to the row (the table has no delete). */
export const REMOVED_REASON = 'removed';

/** The name of the model inside an Executor id: lower case, `a-z0-9._-` only. */
export function aliasOfModel(modelId: string): string {
  const slash = modelId.indexOf('/');
  const base = slash === -1 ? modelId : modelId.slice(slash + 1);
  return base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-+$/, '');
}

/** Context window of a model for a role (per slot for a local one is the catalog's own number). */
function shortfallText(requires: RoleRequires, info: ModelInfo): string | null {
  const parts: string[] = [];
  if (
    requires.context !== undefined &&
    info.contextWindow !== undefined &&
    info.contextWindow < requires.context
  ) {
    parts.push(`context ${String(info.contextWindow)} < ${String(requires.context)}`);
  }
  if (requires.reasoning === true && info.reasoning === false) parts.push('no reasoning');
  return parts.length === 0 ? null : parts.join(', ');
}

function viewOf(
  record: ExecutorRecord,
  entry: ExecutorEntry | undefined,
  roles: readonly RoleId[],
): ExecutorView {
  const parsed = tryParseExecutorId(record.id);
  const [client = '', profile = ''] = record.profileId.split('/');
  return {
    id: record.id,
    profileId: record.profileId,
    client: typeof parsed === 'string' ? client : parsed.client,
    profile: typeof parsed === 'string' ? profile : parsed.profile,
    model: entry?.model ?? record.model,
    effort: record.effort,
    provider: record.provider,
    validity: record.validity,
    invalidReason: record.invalidReason,
    configured: entry !== undefined,
    roles,
  };
}

/** The body of `executors.<id>` in the configuration. */
export interface ExecutorConfigEntry {
  readonly client: string;
  readonly profile: string;
  readonly model: string;
  readonly effort?: string;
  readonly provider?: string;
  readonly preset_expand?: false;
}

/**
 * The body of `executors.<id>` the cadastro writes (and the setup assistant, P4 of docs/18, writes
 * the same way). The provider is left out when the client fixes it; `presetExpand: false` is
 * `executors.on_register: none` (N136).
 */
export function executorConfigEntry(fields: {
  readonly client: string;
  readonly profile: string;
  readonly model: string;
  readonly effort: string | null;
  readonly provider: string;
  readonly presetExpand: boolean;
}): ExecutorConfigEntry {
  return {
    client: fields.client,
    profile: fields.profile,
    model: fields.model,
    ...(fields.effort === null ? {} : { effort: fields.effort }),
    ...(FIXED_PROVIDER_OF_CLIENT[fields.client] === undefined
      ? { provider: fields.provider }
      : {}),
    ...(fields.presetExpand ? {} : { preset_expand: false as const }),
  };
}

export class ExecutorService {
  readonly #o: ExecutorServiceOptions;

  constructor(options: ExecutorServiceOptions) {
    this.#o = options;
  }

  /** The models of a profile as its catalog lists them, each with what `suggest` fills in. */
  async models(
    profileId: string,
  ): Promise<readonly { readonly info: ModelInfo; readonly draft: ExecutorDraftView }[]> {
    const ref = parseProfileId(profileId);
    await this.#profileOf(profileId);
    const catalog = this.#catalogOf(ref.client);
    const listed = await catalog.list(ref);
    return listed.map((info) => ({ info, draft: this.#draftOf(ref.client, catalog, info, {}) }));
  }

  /** Registers an Executor. See the module comment for the steps. */
  async add(input: AddExecutorInput): Promise<AddExecutorResult> {
    const { store } = this.#o;
    const config = await loadConfig(this.#o.configPath);
    const ref = parseProfileId(input.profileId);
    const profile = await this.#profileOf(input.profileId);
    if (profile.state !== 'active') {
      throw new Conflict(
        `Profile ${profile.id} is ${profile.state}; register Executors on an active one`,
      );
    }
    if (
      input.effort !== undefined &&
      !(EFFORT_LEVELS as readonly string[]).includes(input.effort)
    ) {
      throw new InvalidInput(
        `effort: use ${EFFORT_LEVELS.join(', ')} (got ${JSON.stringify(input.effort)})`,
      );
    }
    const catalog = this.#catalogOf(ref.client);
    const issues: RegisterIssue[] = [];

    // 1. The model, from the catalog.
    const listed = await catalog.list(ref);
    const info = listed.find((candidate) => candidate.id === input.model);
    if (info === undefined) {
      const near = listed
        .filter((candidate) => candidate.id.toLowerCase().includes(input.model.toLowerCase()))
        .slice(0, 5)
        .map((candidate) => candidate.id);
      return {
        status: 'refused',
        draft: null,
        issues: [
          {
            code: 'model_not_found',
            severity: 'error',
            message: `the model ${input.model} is not in the catalog of ${profile.id}${near.length > 0 ? `; similar: ${near.join(', ')}` : ''}`,
          },
        ],
      };
    }

    // 2. The fields, pre-filled by the catalog and corrected by the Producer.
    const draft = this.#draftOf(ref.client, catalog, info, input);
    const effort = draft.effort;
    const missing: MissingField[] = [];
    const fixed = FIXED_PROVIDER_OF_CLIENT[ref.client];
    if (draft.provider === null) {
      missing.push('family');
      issues.push({
        code: 'family_required',
        severity: 'error',
        message: `the catalog gives no family for ${info.id} and ${ref.client} does not fix the provider; pass the family (--family), for example "minimax"`,
      });
    }
    if (draft.alias === null || draft.id === null) {
      missing.push('alias');
      issues.push({
        code: 'name_invalid',
        severity: 'error',
        message: `the model ${info.id} does not give a valid Executor name; pass one with --as (lower case letters, digits, "-", "." and "_", not ending in -low, -medium or -high)`,
      });
    }

    // 3. The local server of a model that runs on this machine (5.7, step 2).
    let localBlock: 'created' | 'kept' | 'none' = 'none';
    let localConfig: LocalConfig | undefined;
    if (info.local || input.localUrl !== undefined) {
      if (config.profiles.entries[profile.id]?.local !== undefined) {
        localBlock = 'kept';
      } else {
        const url = input.localUrl ?? info.baseUrl;
        if (url === undefined) {
          missing.push('local_url');
          issues.push({
            code: 'local_url_required',
            severity: 'error',
            message: `${info.id} runs on this machine and the catalog gives no URL; pass it (--local-url) to write profiles.${profile.id}.local`,
          });
        } else {
          const parsed = LocalConfigSchema.safeParse({
            server: input.localServer ?? 'llama-cpp',
            url,
          });
          if (parsed.success) {
            localConfig = parsed.data;
            localBlock = 'created';
          } else {
            throw new InvalidInput(
              `profiles.${profile.id}.local: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
            );
          }
        }
      }
    }

    // 4. The catalog's own validation: the model calls tools, takes the effort...
    if (draft.id !== null) {
      const validation = await catalog.validate({
        profile: ref,
        model: info.id,
        ...(effort === null ? {} : { effort }),
      });
      for (const issue of validation.issues) {
        // The "does not say" case stays a warning: the test session is what settles it.
        issues.push({ code: issue.code, severity: issue.severity, message: issue.message });
      }
    }
    const draftView: ExecutorDraftView = draft;
    if (missing.length > 0) return { status: 'needs_input', missing, draft: draftView, issues };
    if (issues.some((issue) => issue.severity === 'error')) {
      return { status: 'refused', draft: draftView, issues };
    }
    const id = draft.id ?? '';
    const provider = draft.provider ?? '';

    // 5. Already there?
    const row = await store.executors.get(id);
    if (
      config.executors.entries[id] !== undefined ||
      (row !== undefined && row.invalidReason !== REMOVED_REASON)
    ) {
      throw new Conflict(`Executor ${id} is already registered`);
    }

    // 6. The roles: what `on_register` plans plus what the Producer named.
    const facts = await this.#facts();
    const entry: ExecutorEntry = {
      id,
      client: ref.client,
      profile: ref.profile,
      model: info.id,
      effort,
      provider: fixed ?? provider,
      ...(config.executors.on_register === 'none' ? { presetExpand: false } : {}),
    };
    const before = this.#resolveLists(config, facts, [...Object.values(config.executors.entries)]);
    const explicitLists: Partial<Record<RoleId, string[]>> = {};
    for (const role of ROLE_IDS) {
      const list = config.roles[role]?.executors;
      if (list !== undefined) explicitLists[role] = [...list];
    }
    const preset = config.roles.preset ?? DEFAULT_ROLE_PRESET;
    const plan = planRegistration({
      executorId: id,
      mode: config.executors.on_register,
      preset,
      currentLists: explicitLists,
    });
    const capabilityCheck = config.roles.capability_check ?? 'warn';
    const wanted = new Map<RoleId, { position: number; explicit: boolean }>();
    for (const placement of plan.apply)
      wanted.set(placement.role, { position: placement.position, explicit: false });
    for (const own of input.roles ?? []) {
      const length = (explicitLists[own.role] ?? before.get(own.role) ?? []).length;
      wanted.set(own.role, { position: Math.min(own.position ?? length, length), explicit: true });
    }
    const writes: { role: RoleId; position: number; list: readonly string[] | null }[] = [];
    const placements: PlacementReport[] = [];
    for (const [role, where] of wanted) {
      const requires: RoleRequires = {
        ...DEFAULT_ROLE_REQUIRES[role],
        ...stripUndefined(config.roles[role]?.requires),
      };
      const short = capabilityCheck === 'off' ? null : shortfallText(requires, info);
      if (short !== null) {
        if (capabilityCheck === 'block' && where.explicit) {
          issues.push({
            code: 'below_minimum',
            severity: 'error',
            message: `${id} is below the minimum of the role ${role} (${short}) and roles.capability_check is "block"`,
          });
          continue;
        }
        if (capabilityCheck === 'block') {
          issues.push({
            code: 'below_minimum',
            severity: 'info',
            message: `${id} is left out of the role ${role}: below its minimum (${short}) and roles.capability_check is "block"`,
          });
          continue;
        }
        issues.push({
          code: 'below_minimum',
          severity: 'warning',
          message: `${id} is below the minimum of the role ${role} (${short}); kept marked (roles.capability_check: warn)`,
        });
      }
      const own = explicitLists[role];
      if (own !== undefined) {
        writes.push({ role, position: where.position, list: null });
        placements.push({ role, via: 'list', position: where.position, inList: true });
      } else if (where.explicit) {
        // The role has no list of its own: the list the preset gives becomes the Producer's.
        const current = before.get(role) ?? [];
        const position = Math.min(where.position, current.length);
        writes.push({ role, position, list: current });
        placements.push({ role, via: 'list', position, inList: true });
      } else {
        placements.push({ role, via: 'preset', position: where.position, inList: true });
      }
    }
    if (issues.some((issue) => issue.severity === 'error')) {
      return { status: 'refused', draft: draftView, issues };
    }

    const view = (validity: 'valid' | 'invalid', reason: string | null): ExecutorView => ({
      id,
      profileId: profile.id,
      client: ref.client,
      profile: ref.profile,
      model: info.id,
      effort,
      provider: entry.provider,
      validity,
      invalidReason: reason,
      configured: true,
      roles: placements.map((placement) => placement.role),
    });
    const configEntry = executorConfigEntry({
      client: ref.client,
      profile: ref.profile,
      model: info.id,
      effort,
      provider,
      // N136: `on_register: none` also keeps the Executor out of the expansion of presets; it
      // enters only the roles that name it.
      presetExpand: config.executors.on_register !== 'none',
    });
    const base = {
      draft: draftView,
      options: plan.options,
      onRegister: plan.mode,
      localBlock,
      cost: draft.cost,
      configEntry,
      localConfig:
        localConfig === undefined ? null : { server: localConfig.server, url: localConfig.url },
    };
    if (input.dryRun === true) {
      return {
        status: 'dry_run',
        executor: view('valid', null),
        issues,
        placements,
        testSession: 'skipped',
        ...base,
      };
    }

    // 7. The short test session (5.7, step 4): it calls the model, so it is the last check.
    let testSession: 'skipped' | 'approved' | 'failed' = 'skipped';
    const sessionMode = input.testSession ?? config.executors.test_session;
    if (sessionMode === 'run') {
      if (this.#o.testSession === undefined) {
        issues.push({
          code: 'test_session_unavailable',
          severity: 'warning',
          message:
            'executors.test_session is "run" but this command has no execution to run the session; the model was not called',
        });
      } else {
        const result = await this.#runSession(profile, entry);
        if (result.ok) {
          testSession = 'approved';
          issues.push({
            code: 'test_session',
            severity: 'info',
            message: `test session approved: ${result.detail}`,
          });
        } else {
          testSession = 'failed';
          const message = `test session failed: ${result.detail}`;
          if (capabilityCheck === 'block') {
            issues.push({
              code: 'test_session_failed',
              severity: 'error',
              message: `${message} (roles.capability_check: block)`,
            });
            return { status: 'refused', draft: draftView, issues };
          }
          issues.push({
            code: 'test_session_failed',
            severity: capabilityCheck === 'warn' ? 'warning' : 'info',
            message,
          });
        }
      }
    }

    // 8. Write: the configuration first (it validates itself), then the table.
    await editConfigFile(this.#o.configPath, (editor) => {
      editor.set(['executors', id], configEntry);
      if (localConfig !== undefined) {
        editor.set(['profiles', profile.id, 'local'], {
          server: localConfig.server,
          url: localConfig.url,
        });
      }
      for (const write of writes) {
        const path = ['roles', write.role, 'executors'];
        if (write.list === null) editor.insert(path, write.position, id);
        else
          editor.set(path, [
            ...write.list.slice(0, write.position),
            id,
            ...write.list.slice(write.position),
          ]);
      }
    });
    try {
      if (row === undefined) {
        await store.executors.create({
          profileId: profile.id,
          model: alias(draft),
          effort,
          provider: entry.provider,
        });
      } else {
        await store.executors.update(id, { provider: entry.provider, validity: 'valid' });
      }
    } catch (error) {
      await this.#unwrite(id, writes, localConfig !== undefined ? profile.id : undefined);
      throw error;
    }
    this.#o.logger.info(
      { executor: id, profile: profile.id, roles: placements.map((p) => p.role) },
      'executor registered',
    );
    await writeSituation(this.#o.store.events, this.#o.logger, 'executor.changed', {
      executorId: id,
      change: 'registered',
      profile: profile.id,
      roles: placements.map((p) => p.role),
    });

    const after = this.#resolveLists(await loadConfig(this.#o.configPath), facts, [
      ...Object.values((await loadConfig(this.#o.configPath)).executors.entries),
    ]);
    const finalPlacements = placements.map((placement) => ({
      ...placement,
      inList: (after.get(placement.role) ?? []).includes(id),
    }));
    return {
      status: 'registered',
      executor: {
        ...view('valid', null),
        roles: ROLE_IDS.filter((role) => (after.get(role) ?? []).includes(id)),
      },
      issues,
      placements: finalPlacements,
      testSession,
      ...base,
    };
  }

  /** The Executors of the configuration and of the table, with the roles that hold each. */
  async list(
    options: { readonly profileId?: string | undefined; readonly all?: boolean | undefined } = {},
  ): Promise<readonly ExecutorView[]> {
    const config = await loadConfig(this.#o.configPath);
    const rows = await this.#o.store.executors.list(
      options.profileId === undefined ? {} : { profileId: options.profileId },
    );
    const entries = config.executors.entries;
    const lists = this.#resolveLists(config, await this.#facts(), Object.values(entries));
    const out: ExecutorView[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      seen.add(row.id);
      if (row.invalidReason === REMOVED_REASON && options.all !== true) continue;
      out.push(viewOf(row, entries[row.id], rolesHolding(lists, row.id)));
    }
    for (const entry of Object.values(entries)) {
      if (seen.has(entry.id)) continue;
      if (
        options.profileId !== undefined &&
        `${entry.client}/${entry.profile}` !== options.profileId
      )
        continue;
      // In the configuration and not in the table yet (a hand-written entry): `check` syncs it.
      out.push({
        id: entry.id,
        profileId: `${entry.client}/${entry.profile}`,
        client: entry.client,
        profile: entry.profile,
        model: entry.model,
        effort: entry.effort,
        provider: entry.provider,
        validity: 'valid',
        invalidReason: null,
        configured: true,
        roles: rolesHolding(lists, entry.id),
      });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Asks the catalog again whether each Executor (or `id`) is still accepted, and settles the
   * validity in the table (5.7: an Executor becomes `invalid` when the model is not accepted any
   * more). A catalog that cannot answer now (client not installed, busy) leaves the row alone.
   */
  async check(id?: string): Promise<readonly CheckedExecutor[]> {
    const config = await loadConfig(this.#o.configPath);
    const { store } = this.#o;
    const rows = new Map((await store.executors.list()).map((row) => [row.id, row]));
    const ids =
      id === undefined
        ? new Set([...rows.keys(), ...Object.keys(config.executors.entries)])
        : new Set([id]);
    if (
      id !== undefined &&
      rows.get(id) === undefined &&
      config.executors.entries[id] === undefined
    ) {
      throw new NotFound(`Executor ${id} is not registered`);
    }
    const out: CheckedExecutor[] = [];
    for (const each of [...ids].sort()) {
      let row = rows.get(each);
      if (row?.invalidReason === REMOVED_REASON && config.executors.entries[each] === undefined)
        continue;
      const entry = config.executors.entries[each];
      const parsed = tryParseExecutorId(each);
      if (typeof parsed === 'string') continue;
      if (row === undefined && entry !== undefined) {
        row = await store.executors.create({
          profileId: parsed.profileId,
          model: parsed.model,
          effort: parsed.effort,
          provider: entry.provider,
        });
      }
      if (row === undefined) continue;
      const model = entry?.model ?? row.model;
      const profile = await store.profiles.get(row.profileId);
      let validity: 'valid' | 'invalid' | 'unchecked';
      let reason: string | null;
      let issues: RegisterIssue[] = [];
      if (profile === undefined || profile.state === 'removed') {
        validity = 'invalid';
        reason = profile === undefined ? 'profile_missing' : 'profile_removed';
      } else {
        const catalog = this.#o.catalogs(profile.client);
        if (catalog === undefined) {
          validity = 'unchecked';
          reason = 'client_unavailable';
        } else {
          try {
            const result = await catalog.validate({
              profile: { client: profile.client, profile: profile.name },
              model,
              ...(row.effort === null ? {} : { effort: row.effort }),
            });
            issues = result.issues.map((issue) => ({
              code: issue.code,
              severity: issue.severity,
              message: issue.message,
            }));
            const failed = result.issues.find((issue) => issue.severity === 'error');
            validity = failed === undefined ? 'valid' : 'invalid';
            reason = failed === undefined ? null : (REASON_OF_CODE[failed.code] ?? failed.code);
          } catch (error) {
            if (!(error instanceof Transient) && !isOTheaterError(error)) throw error;
            validity = 'unchecked';
            reason = error instanceof Error ? error.message : String(error);
          }
        }
      }
      let changed = false;
      if (validity !== 'unchecked' && (row.validity !== validity || row.invalidReason !== reason)) {
        await store.executors.update(
          each,
          validity === 'valid'
            ? { validity: 'valid' }
            : { validity: 'invalid', invalidReason: reason ?? 'invalid' },
        );
        changed = true;
      }
      out.push({ id: each, validity, reason, issues, changed });
    }
    return out;
  }

  /**
   * Takes an Executor out: from `executors.<id>` and from every list of a role that names it. The
   * table has no delete, so the row stays `invalid` with the reason `removed` (the attempts and
   * events that cite it keep a row to point at). The `local` block of the profile stays.
   */
  async remove(id: string): Promise<RemoveExecutorResult> {
    const config = await loadConfig(this.#o.configPath);
    const row = await this.#o.store.executors.get(id);
    const inConfig = config.executors.entries[id] !== undefined;
    const alreadyRemoved = row?.invalidReason === REMOVED_REASON;
    if ((row === undefined || alreadyRemoved) && !inConfig) {
      throw new NotFound(`Executor ${id} is not registered`);
    }
    const rolesChanged: RoleId[] = [];
    const rolesEmptied: RoleId[] = [];
    await editConfigFile(this.#o.configPath, (editor) => {
      editor.remove(['executors', id]);
      for (const role of ROLE_IDS) {
        const list = config.roles[role]?.executors;
        if (!list?.includes(id)) continue;
        editor.withdraw(['roles', role, 'executors'], id);
        rolesChanged.push(role);
        if (list.length === 1) rolesEmptied.push(role);
      }
    });
    if (row !== undefined && !alreadyRemoved) {
      await this.#o.store.executors.update(id, {
        validity: 'invalid',
        invalidReason: REMOVED_REASON,
      });
    }
    this.#o.logger.info({ executor: id, roles: rolesChanged }, 'executor removed');
    await writeSituation(this.#o.store.events, this.#o.logger, 'executor.changed', {
      executorId: id,
      change: 'removed',
      profile: row?.profileId ?? null,
      roles: rolesChanged,
    });
    return { id, rolesChanged, rolesEmptied, inConfig };
  }

  // ---- internals ----------------------------------------------------------------------------

  async #profileOf(id: string): Promise<ProfileRecord> {
    const record = await this.#o.store.profiles.get(id);
    if (record === undefined)
      throw new NotFound(`Profile ${id} does not exist; create it with "ot profile add"`);
    return record;
  }

  #catalogOf(client: string): ModelCatalog {
    const catalog = this.#o.catalogs(client);
    if (catalog === undefined) {
      throw new AdapterUnavailable(
        `The client ${client} is not available: its models cannot be listed`,
      );
    }
    return catalog;
  }

  /** What the cadastro fills in for a model; `given` are the fields the Producer already chose. */
  #draftOf(
    client: string,
    catalog: ModelCatalog,
    info: ModelInfo,
    given: Partial<Pick<AddExecutorInput, 'effort' | 'family' | 'alias' | 'profileId'>>,
  ): ExecutorDraftView {
    const suggested = catalog.suggest(info);
    const levels = EFFORT_LEVELS as readonly string[];
    const effort =
      given.effort ??
      (suggested.effort !== undefined && levels.includes(suggested.effort)
        ? suggested.effort
        : null);
    const fixed = FIXED_PROVIDER_OF_CLIENT[client];
    const family = (given.family ?? suggested.family ?? info.family ?? '').trim();
    const provider = fixed ?? (family === '' ? null : family);
    const aliasName = given.alias ?? aliasOfModel(info.id);
    let id: string | null = null;
    let alias: string | null = null;
    // The name must survive its own parse: an alias that ends in `-high` would be read as an effort.
    const candidate = formatExecutorId({
      model: aliasName,
      effort,
      profileId: given.profileId ?? `${client}/x`,
    });
    const parsed = tryParseExecutorId(candidate);
    if (typeof parsed !== 'string' && parsed.model === aliasName && parsed.effort === effort) {
      alias = aliasName;
      id = given.profileId === undefined ? null : candidate;
    }
    return {
      id,
      model: info.id,
      alias,
      effort,
      efforts: info.efforts,
      provider,
      local: info.local,
      contextWindow: info.contextWindow ?? null,
      reasoning: info.reasoning ?? null,
      toolCalls: info.toolCalls ?? null,
      cost: info.cost ?? null,
    };
  }

  async #facts(): Promise<readonly ProfileFact[]> {
    const profiles = await this.#o.store.profiles.list({});
    return profiles.map((profile) => ({
      id: profile.id,
      kind: profile.kind,
      state: profile.state,
    }));
  }

  /** The Executor ids in the list of each role now (the preset expanded where the role has no list). */
  #resolveLists(
    config: DaemonConfig,
    profiles: readonly ProfileFact[],
    catalog: readonly ExecutorEntry[],
  ): Map<RoleId, readonly string[]> {
    const resolved = resolveRoleExecutors({
      layers: [config.roles],
      catalog,
      profiles,
      crossClient: config.executors.cross_client,
    });
    return new Map(
      ROLE_IDS.map((role) => [role, resolved.roles[role].executors.map((item) => item.id)]),
    );
  }

  async #runSession(profile: ProfileRecord, entry: ExecutorEntry): Promise<TestSessionResult> {
    const session = this.#o.testSession;
    if (session === undefined) return { ok: false, detail: 'no test session available' };
    try {
      return await session.run({
        profile: {
          client: profile.client,
          profile: profile.name,
          id: profile.id,
          dir: profile.dir,
        },
        model: entry.model,
        effort: entry.effort,
        executorId: entry.id,
      });
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Best effort: takes back what `add` wrote to the configuration when the table refused the row. */
  async #unwrite(
    id: string,
    writes: readonly { role: RoleId }[],
    localOf: string | undefined,
  ): Promise<void> {
    try {
      await editConfigFile(this.#o.configPath, (editor) => {
        editor.remove(['executors', id]);
        for (const write of writes) editor.withdraw(['roles', write.role, 'executors'], id);
        if (localOf !== undefined) editor.remove(['profiles', localOf, 'local']);
      });
    } catch (error) {
      this.#o.logger.error(
        { executor: id, err: error },
        'could not undo the configuration of an Executor',
      );
    }
  }
}

function alias(draft: ExecutorDraftView): string {
  return draft.alias ?? '';
}

function rolesHolding(lists: ReadonlyMap<RoleId, readonly string[]>, id: string): RoleId[] {
  return ROLE_IDS.filter((role) => (lists.get(role) ?? []).includes(id));
}

function stripUndefined(requires: RoleRequires | undefined): RoleRequires {
  const out: { context?: number; reasoning?: boolean } = {};
  if (requires?.context !== undefined) out.context = requires.context;
  if (requires?.reasoning !== undefined) out.reasoning = requires.reasoning;
  return out;
}
