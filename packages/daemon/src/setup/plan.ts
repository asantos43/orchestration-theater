// SPDX-License-Identifier: MPL-2.0
import {
  DEFAULT_ROLE_PRESET,
  ROLE_IDS,
  planRegistration,
  resolveRoleExecutors,
  tryParseExecutorId,
  type ExecutorEntry,
  type ProfileFact,
  type RolePresetName,
  type RoleId,
  type RolesLayer,
  type SetupFlow,
} from '@otheater/core';
import type {
  SetupBudget,
  SetupExecutor,
  SetupNote,
  SetupPlan,
  SetupRolePlacement,
} from '@otheater/protocol';
import type { DaemonConfig, SetupRoleListMode } from '../config.js';
import { legacyExecutorsOf } from '../orchestration/role-executors.js';

/**
 * The plan of the setup assistant (architecture 5.7; P4 of docs/18): what `confirm` will write,
 * computed from the configuration as it is now, the accounts of the run, the Executors the
 * catalogs gave and the Producer registered, and the caps. Pure: the `preset` step shows it as a
 * preview, `review` shows it, and `confirm` applies the very same result, so what the Producer
 * saw is what is written. Nothing here reads a file, the store or a client.
 */

/** What the plan is computed from. */
export interface PlanInput {
  readonly flow: SetupFlow;
  /** The configuration now (the file may have been edited by hand since the run began). */
  readonly config: Pick<DaemonConfig, 'roles' | 'executors' | 'profiles' | 'orchestration'>;
  /** The accounts that take part, in the order the lists take them. */
  readonly profiles: readonly ProfileFact[];
  /** The preset to write; `null` leaves `roles.preset` as it is (adding an account). */
  readonly preset: RolePresetName | null;
  /** The Executors the catalogs of the official clients gave for the heads of the preset. */
  readonly discovered: readonly SetupExecutor[];
  /** The Executors the Producer registered in the `executors` step. */
  readonly registered: readonly SetupExecutor[];
  /** The caps the Producer gave. */
  readonly givenBudgets: readonly SetupBudget[];
  /**
   * N333 [proposta]: the roles the Producer gave to Executors of the run at the review; each one
   * enters at the END of the list of each role named. Default none.
   */
  readonly placements?: readonly SetupRolePlacement[] | undefined;
  /** What the notes of the earlier steps said (discovery, checks of the cadastro). */
  readonly carriedNotes: readonly SetupNote[];
  /**
   * N334 [proposta]: what the daemon says of the layers of guarantee. Absent: the plan says
   * nothing of them (a flow of a test, a tool with no daemon). `layer3` false with `unenforced:
   * refuse` means the Director does not open on this machine; `answer` is what the `security` step
   * got (`warn`: write `security.unenforced: warn`; `keep`: the question was asked and refused;
   * `none`: it was not asked).
   */
  readonly security?:
    | {
        readonly layer3: boolean;
        readonly unenforced: 'refuse' | 'warn' | 'allow';
        readonly answer: 'warn' | 'keep' | 'none';
      }
    | undefined;
  readonly settings: {
    readonly suggestedBudget: { readonly dailyUsd: number; readonly monthlyUsd: number };
    readonly roleLists: SetupRoleListMode;
  };
}

/** What `confirm` does with the configuration and the table of the Executors. */
export interface PlanApply {
  /** `roles.preset` to write, or `null`. */
  readonly preset: RolePresetName | null;
  /** `roles.<role>.executors` to write whole (`setup.role_lists: explicit`); an empty list takes the key out. */
  readonly lists: readonly { readonly role: RoleId; readonly executors: readonly string[] }[];
  /** Places in a list that already is the Producer's (`insert` at `position`). */
  readonly insertions: readonly {
    readonly role: RoleId;
    readonly position: number;
    readonly id: string;
  }[];
  /** `executors.<id>` (and the rows) to write. */
  readonly executors: readonly SetupExecutor[];
  /** The caps to write; a `null` field takes the key out. */
  readonly budgets: readonly SetupBudget[];
  /** `security.unenforced` to write (N334), or `null`. It is read at the start: a restart takes it in. */
  readonly unenforced: 'warn' | null;
}

export interface PlanResult {
  readonly plan: SetupPlan;
  readonly apply: PlanApply;
}

/** An Executor of the plan as the resolution knows it. */
export function entryOf(executor: SetupExecutor): ExecutorEntry {
  const [client = '', profile = ''] = executor.profileId.split('/');
  return {
    id: executor.id,
    client,
    profile,
    model: executor.model,
    effort: executor.effort,
    provider: executor.provider,
    ...(executor.presetExpand ? {} : { presetExpand: false }),
  };
}

/** The account of a note about an Executor, read from its id (`<model>-<effort>@<client>/<profile>`). */
function profileOfExecutor(executorId: string | null): { profileId?: string } {
  if (executorId === null) return {};
  const parsed = tryParseExecutorId(executorId);
  return typeof parsed === 'string' ? {} : { profileId: parsed.profileId };
}

function hasCap(budget: {
  daily_usd?: number | undefined;
  monthly_usd?: number | undefined;
}): boolean {
  return budget.daily_usd !== undefined || budget.monthly_usd !== undefined;
}

export function buildPlan(input: PlanInput): PlanResult {
  const { config, flow, settings } = input;
  const notes: SetupNote[] = [...input.carriedNotes];
  const inConfig = new Set(Object.keys(config.executors.entries));

  // The Executors this run adds: an id the file already has is the Producer's and stays as it is.
  const added = new Map<string, SetupExecutor>();
  for (const executor of [...input.discovered, ...input.registered]) {
    if (!inConfig.has(executor.id) && !added.has(executor.id)) added.set(executor.id, executor);
  }
  const toWrite = [...added.values()];
  const catalog: ExecutorEntry[] = [
    ...Object.values(config.executors.entries),
    ...toWrite.map(entryOf),
  ];

  // The lists: with an explicit mode (and a flow that chooses a preset) the lists the preset gives
  // replace the ones in the file; otherwise the ones in the file stay and the new Executors enter
  // them where `executors.on_register` says.
  const choosesPreset = input.preset !== null;
  const rewriteLists = choosesPreset && settings.roleLists === 'explicit';
  const effectivePreset: RolePresetName =
    input.preset ?? config.roles.preset ?? DEFAULT_ROLE_PRESET;
  const base: RolesLayer = config.roles;
  const layer: RolesLayer = rewriteLists
    ? {
        ...base,
        preset: effectivePreset,
        ...Object.fromEntries(
          ROLE_IDS.flatMap((role) => {
            const own = base[role];
            return own === undefined ? [] : [[role, { ...own, executors: undefined }]];
          }),
        ),
      }
    : { ...base, ...(choosesPreset ? { preset: effectivePreset } : {}) };
  const legacy = legacyExecutorsOf(config.orchestration);
  if (rewriteLists && Object.keys(legacy).length > 0) {
    notes.push({
      severity: 'warning',
      code: 'legacy_executors',
      role: null,
      message:
        'orchestration.executor and orchestration.roles.<role> are the old format; the lists written here take their place',
    });
  }
  const resolved = resolveRoleExecutors({
    layers: [layer],
    ...(rewriteLists ? {} : { legacy }),
    catalog,
    profiles: input.profiles,
    crossClient: config.executors.cross_client,
  });
  for (const note of resolved.notes) {
    notes.push({
      severity: note.severity,
      code: note.code,
      role: note.role,
      ...(note.head === undefined ? {} : { head: note.head }),
      ...(note.executorId === null ? {} : { executorId: note.executorId }),
      ...profileOfExecutor(note.executorId),
      message: note.message,
    });
  }

  const lists = new Map<RoleId, string[]>();
  for (const role of ROLE_IDS)
    lists.set(
      role,
      resolved.roles[role].executors.map((item) => item.id),
    );

  // The lists the file keeps get the new Executors where `on_register` puts them.
  const insertions: { role: RoleId; position: number; id: string }[] = [];
  const explicit: Partial<Record<RoleId, string[]>> = {};
  if (!rewriteLists) {
    for (const role of ROLE_IDS) {
      const own = base[role]?.executors;
      if (own !== undefined) explicit[role] = [...own];
    }
    for (const executor of toWrite) {
      const registration = planRegistration({
        executorId: executor.id,
        // `ask` is the question the review answers: the placements are in the plan, and the
        // Producer confirms them there; so the assistant applies the ones the preset names.
        mode: config.executors.on_register === 'ask' ? 'preset_only' : config.executors.on_register,
        preset: effectivePreset,
        currentLists: explicit,
      });
      for (const placement of registration.apply) {
        const own = explicit[placement.role];
        if (own === undefined) continue;
        const position = Math.min(placement.position, own.length);
        own.splice(position, 0, executor.id);
        insertions.push({ role: placement.role, position, id: executor.id });
        const shown = lists.get(placement.role) ?? [];
        shown.splice(Math.min(position, shown.length), 0, executor.id);
        lists.set(placement.role, shown);
      }
    }
  }

  // N333: the roles the Producer gave at the review take the Executor at the END of their lists. A
  // list the file keeps gets an insertion; a role with no list in the file gets the list it has now
  // (the preset's, resolved) plus the Executor, written whole, since there is nothing to insert in.
  const known = new Set(catalog.map((entry) => entry.id));
  const frozen = new Map<RoleId, string[]>();
  for (const placement of input.placements ?? []) {
    if (!known.has(placement.executorId)) continue;
    for (const role of ROLE_IDS.filter((id) => placement.roles.includes(id))) {
      const shown = lists.get(role) ?? [];
      if (shown.includes(placement.executorId)) continue;
      shown.push(placement.executorId);
      lists.set(role, shown);
      if (rewriteLists) continue;
      const own = explicit[role];
      if (own === undefined) {
        frozen.set(role, [...shown]);
        continue;
      }
      own.push(placement.executorId);
      insertions.push({ role, position: own.length - 1, id: placement.executorId });
    }
  }

  const replaced = rewriteLists
    ? ROLE_IDS.filter((role) => {
        const own = base[role]?.executors;
        const next = lists.get(role) ?? [];
        return own !== undefined && own.join('\n') !== next.join('\n');
      })
    : [];
  for (const role of replaced) {
    notes.push({
      severity: 'warning',
      code: 'lists_replaced',
      role,
      message: `roles.${role}.executors in the file is replaced by the list of the preset`,
    });
  }

  // The caps: every API account that got an Executor and has no cap yet takes the suggested one,
  // unless the Producer gave one (or `null` for none).
  const given = new Map(input.givenBudgets.map((budget) => [budget.profileId, budget]));
  const kindOf = new Map(input.profiles.map((profile) => [profile.id, profile.kind]));
  const budgets: SetupBudget[] = [];
  for (const budget of given.values()) budgets.push(budget);
  const withNew = new Set(toWrite.map((executor) => executor.profileId));
  for (const profileId of input.profiles.map((profile) => profile.id)) {
    if (given.has(profileId) || kindOf.get(profileId) !== 'api' || !withNew.has(profileId))
      continue;
    const existing = config.profiles.entries[profileId]?.budget;
    if (existing !== undefined && hasCap(existing)) continue;
    budgets.push({
      profileId,
      dailyUsd: settings.suggestedBudget.dailyUsd,
      monthlyUsd: settings.suggestedBudget.monthlyUsd,
    });
    notes.push({
      severity: 'info',
      code: 'budget_suggested',
      role: null,
      profileId,
      message: `${profileId} is an API account with no cap: the suggested one (setup.suggested_budget) is proposed`,
    });
  }

  if (input.profiles.length === 0) {
    notes.push({
      severity: 'warning',
      code: 'no_accounts',
      role: null,
      message: 'no account takes part: the lists of the roles stay empty until one is added',
    });
  }

  // N334: the layers of guarantee. A "yes" to the question writes `warn`; a "no" (or no question,
  // `setup.unenforced_prompt: never`) leaves the file, and the review says the Director does not open.
  const security = input.security;
  const unenforced: 'warn' | null =
    security?.answer === 'warn' && !security.layer3 && security.unenforced !== 'warn'
      ? 'warn'
      : null;
  if (security !== undefined && flow === 'first_run' && !security.layer3) {
    if (unenforced !== null) {
      notes.push({
        severity: 'warning',
        code: 'unenforced_warn',
        role: null,
        message:
          'security.unenforced: warn is written: without layer 3 (the sandbox) the write scope and the network have no guarantee; the daemon takes it in after a restart',
      });
    } else if (security.unenforced === 'refuse') {
      notes.push({
        severity: 'warning',
        code: 'director_will_not_open',
        role: null,
        message:
          'layer 3 (the sandbox) is missing here and security.unenforced is refuse: the Director will not open; set security.unenforced to warn or allow, or run the assistant again',
      });
    }
  }

  // What gets written, as the dotted keys of `config.yaml`.
  const writes: string[] = [];
  if (choosesPreset) writes.push('roles.preset');
  if (unenforced !== null) writes.push('security.unenforced');
  // An empty list is never written: a role that has none in the file falls back to the preset, and
  // a list the file had for a role that now has none is taken out.
  const listsToWrite = rewriteLists
    ? ROLE_IDS.flatMap((role) => {
        const ids = lists.get(role) ?? [];
        return ids.length === 0 && base[role]?.executors === undefined
          ? []
          : [{ role, executors: ids }];
      })
    : ROLE_IDS.flatMap((role) => {
        const ids = frozen.get(role);
        return ids === undefined ? [] : [{ role, executors: ids }];
      });
  for (const list of listsToWrite) writes.push(`roles.${list.role}.executors`);
  for (const role of new Set(insertions.map((insertion) => insertion.role))) {
    writes.push(`roles.${role}.executors`);
  }
  for (const executor of toWrite) {
    writes.push(`executors.${executor.id}`);
    if (executor.local !== null) writes.push(`profiles.${executor.profileId}.local`);
  }
  for (const budget of budgets) writes.push(`profiles.${budget.profileId}.budget`);

  const plan: SetupPlan = {
    flow,
    preset: input.preset,
    roles: ROLE_IDS.map((role) => ({
      role,
      executors: lists.get(role) ?? [],
      whenExhausted: resolved.roles[role].whenExhausted,
    })),
    executors: toWrite,
    budgets,
    writes: [...new Set(writes)],
    notes,
  };
  return {
    plan,
    apply: {
      preset: input.preset,
      lists: listsToWrite,
      insertions,
      executors: toWrite,
      budgets,
      unenforced,
    },
  };
}
