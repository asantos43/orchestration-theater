// SPDX-License-Identifier: MPL-2.0
import type {
  SetupDoneStep,
  SetupExecutor,
  SetupExecutorRequest,
  SetupModelCatalogState,
  SetupModelFloating,
  SetupModels,
  SetupRoleList,
  SetupRolePlacement,
  SetupRunView,
} from '@otheater/protocol';
import { ROLE_IDS } from './role-pick.js';

/**
 * The list of models of the step "Executores" (N333, the owner on 2026-11-26): per account, the
 * models the client catalog lists, checked with Space, with the effort of each one chosen with the
 * left and right arrows. What the preset uses starts checked, at the effort the preset gives it.
 * This module is pure: the rows, what each key does to them and what they give the step. The route
 * is the one of the list after a login (N324, `GET /v1/setup/models/:client/:name`); nothing here
 * calls the daemon.
 *
 * N335 (the owner on 2026-11-27): the rows are also the lines of a table with the roles of each
 * Executor (`ui.setup.executorsLayout`); a row whose roles the person changed carries them in
 * `roles`, and the answer of the step sends them as an exact placement.
 */

/** A role of the seven the preset names. */
export type RowRole = SetupRoleList['role'];

/** The efforts a model takes when its catalog lists none. [proposta] N333, item 2. */
export const DEFAULT_EFFORTS = ['low', 'medium', 'high'] as const;

/** The effort a new row starts on when the preset says none: `medium` if accepted, else the first. */
function defaultEffort(efforts: readonly string[]): string | null {
  if (efforts.includes('medium')) return 'medium';
  return efforts[0] ?? null;
}

/** The Executor of the preset a row starts as (`discovered` of the run). */
export interface RowSeed {
  /** `<model>-<effort>@<client>/<profile>`: what the preset names. */
  readonly id: string;
  readonly effort: string | null;
  /** The name of the model inside the id (`codex-sol`): a request keeps it, so the name stays the preset's. */
  readonly alias: string;
}

/** One model of one account, at one effort. */
export interface ExecutorRow {
  readonly profileId: string;
  /** The model id as the catalog lists it. */
  readonly model: string;
  readonly name: string | null;
  readonly floating: SetupModelFloating | null;
  /** The efforts the model takes ({@link DEFAULT_EFFORTS} when the catalog lists none). */
  readonly efforts: readonly string[];
  /** The effort now; `null` only for a row the preset gives with none. */
  readonly effort: string | null;
  readonly on: boolean;
  readonly seed: RowSeed | null;
  /** The model already runs as an Executor of the account: it is shown, and does not take part. */
  readonly registered: boolean;
  /**
   * N335 [proposta]: the roles the person chose for this row, when they differ from the ones the
   * preset gives it; absent while the row keeps the preset's. The answer sends them as `exact`.
   */
  readonly roles?: readonly RowRole[];
}

/** What the catalog said of one account, for the heading of its rows. */
export interface ExecutorGroup {
  readonly profileId: string;
  /** `failed`: the route did not answer (see `reason`). */
  readonly catalog: SetupModelCatalogState | 'failed';
  readonly reason: string | null;
}

/** What the read of the models of one account gave. */
export interface ModelsRead {
  readonly profileId: string;
  readonly found?: SetupModels;
  readonly failure?: string;
}

/** `codex-sol-high@codex/main` with effort `high` gives `codex-sol`. */
function aliasOf(id: string, effort: string | null): string {
  const at = id.lastIndexOf('@');
  const head = at <= 0 ? id : id.slice(0, at);
  return effort !== null && head.endsWith(`-${effort}`)
    ? head.slice(0, head.length - effort.length - 1)
    : head;
}

/** The id the preset style gives an Executor: `<alias>-<effort>@<account>`. */
export function presetIdOf(row: ExecutorRow): string | undefined {
  const alias = row.seed?.alias;
  if (alias === undefined) return undefined;
  return `${alias}${row.effort === null ? '' : `-${row.effort}`}@${row.profileId}`;
}

/**
 * The Executors of the preset a model starts as. With the `discovered` of the run, they are the
 * run's: the route marks the models with the preset in force in the configuration, and the run may
 * have chosen another one (a row seeded by the other preset would ask the daemon for an Executor the
 * run already has, and the step is refused as "given twice").
 */
function seedsOf(
  profileId: string,
  model: SetupModels['models'][number],
  discovered: readonly SetupExecutor[] | undefined,
): { id: string; effort: string | null }[] {
  const all =
    discovered === undefined
      ? model.preset
      : discovered
          .filter((executor) => executor.profileId === profileId && executor.model === model.id)
          .map((executor) => ({ id: executor.id, effort: executor.effort }));
  return all.filter((entry, at) => all.findIndex((x) => x.id === entry.id) === at);
}

function rowsOf(
  profileId: string,
  found: SetupModels,
  discovered: readonly SetupExecutor[] | undefined,
): ExecutorRow[] {
  const rows: ExecutorRow[] = [];
  for (const model of found.models) {
    const efforts = model.efforts.length > 0 ? model.efforts : [...DEFAULT_EFFORTS];
    const base = {
      profileId,
      model: model.id,
      name: model.name,
      floating: model.floating,
      efforts,
    };
    if (model.registered.length > 0) {
      rows.push({ ...base, effort: null, on: false, seed: null, registered: true });
      continue;
    }
    const seeds = seedsOf(profileId, model, discovered);
    if (seeds.length === 0) {
      rows.push({
        ...base,
        effort: defaultEffort(efforts),
        on: false,
        seed: null,
        registered: false,
      });
      continue;
    }
    for (const entry of seeds) {
      rows.push({
        ...base,
        effort: entry.effort,
        on: true,
        seed: { id: entry.id, effort: entry.effort, alias: aliasOf(entry.id, entry.effort) },
        registered: false,
      });
    }
  }
  return rows;
}

/**
 * The rows and groups the reads give, in the order of the reads (the accounts of the run). With
 * `discovered` (what the catalogs found for the preset of the run), the rows start as the run's
 * Executors, not as the ones of the preset the route read.
 */
export function listOf(
  reads: readonly ModelsRead[],
  discovered?: readonly SetupExecutor[],
): {
  rows: ExecutorRow[];
  groups: ExecutorGroup[];
} {
  const rows: ExecutorRow[] = [];
  const groups: ExecutorGroup[] = [];
  for (const read of reads) {
    if (read.found === undefined) {
      groups.push({ profileId: read.profileId, catalog: 'failed', reason: read.failure ?? null });
      continue;
    }
    groups.push({
      profileId: read.profileId,
      catalog: read.found.catalog,
      reason: read.found.reason,
    });
    if (read.found.catalog === 'listed')
      rows.push(...rowsOf(read.profileId, read.found, discovered));
  }
  return { rows, groups };
}

/**
 * What the list of models after a login (N324) already chose, brought into the rows: a typed
 * request for a model of a row that is off checks the row (at the effort the request gave, when the
 * model takes it); an id of `exclude` that a row starts as unchecks it. What matches no row stays
 * where it was.
 */
export function seededRows(
  rows: readonly ExecutorRow[],
  executors: readonly SetupExecutorRequest[],
  exclude: readonly string[],
): { rows: ExecutorRow[]; executors: SetupExecutorRequest[]; exclude: string[] } {
  const next = rows.map((row) => ({ ...row }));
  const left: SetupExecutorRequest[] = [];
  const used = new Set<number>();
  for (const request of executors) {
    const at = next.findIndex(
      (row, index) =>
        !used.has(index) &&
        !row.registered &&
        !row.on &&
        row.profileId === request.profileId &&
        row.model === request.model &&
        (request.effort === undefined || row.efforts.includes(request.effort)),
    );
    const row = next[at];
    if (row === undefined) {
      left.push(request);
      continue;
    }
    used.add(at);
    next[at] = {
      ...row,
      on: true,
      effort: request.effort ?? row.effort,
    };
  }
  const kept: string[] = [];
  for (const id of exclude) {
    const at = next.findIndex((row) => row.seed?.id === id && row.on);
    const row = next[at];
    if (row === undefined) {
      kept.push(id);
      continue;
    }
    next[at] = { ...row, on: false };
  }
  return { rows: next, executors: left, exclude: kept };
}

/** The row with its mark flipped; a registered row does not take part. */
export function rowToggled(rows: readonly ExecutorRow[], index: number): ExecutorRow[] {
  return rows.map((row, at) => (at === index && !row.registered ? { ...row, on: !row.on } : row));
}

/** The efforts a row cycles through: its own, and none first when the preset gives it with none. */
export function effortOptions(row: ExecutorRow): readonly (string | null)[] {
  return row.seed !== null && row.seed.effort === null ? [null, ...row.efforts] : row.efforts;
}

/** The efforts another row of the same model and account already holds (two rows would be one Executor). */
function takenEfforts(rows: readonly ExecutorRow[], index: number): Set<string | null> {
  const row = rows[index];
  return new Set(
    rows
      .filter(
        (other, at) =>
          row !== undefined &&
          at !== index &&
          other.profileId === row.profileId &&
          other.model === row.model &&
          !other.registered,
      )
      .map((other) => other.effort),
  );
}

/** N335: the efforts the list of a row offers, with the ones another row of the model holds marked. */
export function rowEffortChoices(
  rows: readonly ExecutorRow[],
  index: number,
): { effort: string | null; taken: boolean }[] {
  const row = rows[index];
  if (row === undefined || row.registered) return [];
  const taken = takenEfforts(rows, index);
  return effortOptions(row).map((effort) => ({ effort, taken: taken.has(effort) }));
}

/** N335: the row with the effort chosen in the list; one the model does not take, or another row holds, changes nothing. */
export function rowEffortSet(
  rows: readonly ExecutorRow[],
  index: number,
  effort: string | null,
): ExecutorRow[] {
  const row = rows[index];
  if (row === undefined || row.registered) return [...rows];
  if (!effortOptions(row).includes(effort) || takenEfforts(rows, index).has(effort)) {
    return [...rows];
  }
  return rows.map((other, at) => (at === index ? { ...other, effort } : other));
}

/**
 * The row with its effort moved by `delta` among the ones the model accepts, skipping an effort
 * another row of the same model and account already holds (two rows would be one Executor). [proposta]
 * The cycle stops at the ends.
 */
export function rowEffortMoved(
  rows: readonly ExecutorRow[],
  index: number,
  delta: -1 | 1,
): ExecutorRow[] {
  const row = rows[index];
  if (row === undefined || row.registered) return [...rows];
  const options = effortOptions(row);
  const taken = takenEfforts(rows, index);
  let at = options.indexOf(row.effort);
  if (at < 0) at = 0;
  for (let step = at + delta; step >= 0 && step < options.length; step += delta) {
    const effort = options[step];
    if (effort === undefined || taken.has(effort)) continue;
    return rows.map((other, position) => (position === index ? { ...other, effort } : other));
  }
  return [...rows];
}

/** Where the Executor of a row stands in the answer of the step: its id, or the index of its request. */
export interface RowPlace {
  readonly index: number;
  readonly executorId?: string;
  readonly request?: number;
}

/**
 * What the rows give the step: the requests for the models checked, the preset ids left out and,
 * for the rows whose roles the person changed, the exact placements (N335): by `executorId` for an
 * Executor the preset already names (a row left as the preset has it), by `request` for a new one
 * (the index in the `executors` this returns, which the answer puts before the typed ones). A row
 * whose roles were not changed gives no placement. `places` says where each row that takes part
 * stands in the answer, to find the row of an Executor of the plan afterwards.
 */
export function rowsSubmission(rows: readonly ExecutorRow[]): {
  executors: SetupExecutorRequest[];
  exclude: string[];
  placements: SetupRolePlacement[];
  places: RowPlace[];
} {
  const executors: SetupExecutorRequest[] = [];
  const exclude: string[] = [];
  const placements: SetupRolePlacement[] = [];
  const places: RowPlace[] = [];
  rows.forEach((row, index) => {
    if (row.registered) return;
    const seed = row.seed;
    const requested = (alias?: string): RowPlace => {
      const place = { index, request: executors.length };
      executors.push({
        profileId: row.profileId,
        model: row.model,
        ...(row.effort === null ? {} : { effort: row.effort }),
        ...(alias === undefined ? {} : { alias }),
      });
      return place;
    };
    let place: RowPlace | undefined;
    if (seed !== null) {
      if (row.on && row.effort === seed.effort) {
        place = { index, executorId: seed.id };
      } else {
        exclude.push(seed.id);
        if (row.on) place = requested(seed.alias);
      }
    } else if (row.on) {
      place = requested();
    }
    if (place === undefined) return;
    places.push(place);
    if (row.roles === undefined) return;
    placements.push({
      ...(place.executorId === undefined ? {} : { executorId: place.executorId }),
      ...(place.request === undefined ? {} : { request: place.request }),
      mode: 'exact',
      roles: [...row.roles],
    });
  });
  return { executors, exclude, placements, places };
}

/** The row that gives the Executor `id` of the plan, given the ids the done step lists in the order of the requests. */
export function rowOfExecutor(
  rows: readonly ExecutorRow[],
  requested: readonly string[],
  id: string,
): number | undefined {
  const { places } = rowsSubmission(rows);
  return places.find((place) =>
    place.executorId === undefined
      ? place.request !== undefined && requested[place.request] === id
      : place.executorId === id,
  )?.index;
}

/** N335: the row with its roles set (in the order of the registry); the same as `base` goes back to the preset's. */
export function rowRolesSet(
  rows: readonly ExecutorRow[],
  index: number,
  roles: readonly RowRole[],
  base: readonly RowRole[],
): ExecutorRow[] {
  const wanted = ROLE_IDS.filter((role) => roles.includes(role));
  const same = wanted.join(',') === ROLE_IDS.filter((role) => base.includes(role)).join(',');
  return rows.map((row, at) => {
    if (at !== index || row.registered) return row;
    const next: { -readonly [K in keyof ExecutorRow]: ExecutorRow[K] } = { ...row };
    if (same) delete next.roles;
    else next.roles = wanted;
    return next;
  });
}

// ---- the roles beside a row ----------------------------------------------------------------------

/** The role lists the preset gives in this run (the `roles` of the done `preset` step). */
export function presetRolesOf(done: readonly SetupDoneStep[]): readonly SetupRoleList[] {
  for (const step of done) if (step.step === 'preset') return step.output.roles;
  return [];
}

/** The roles of the preset that hold the Executor id, in the order of the roles. */
export function rolesOfId(roles: readonly SetupRoleList[], id: string | undefined): RowRole[] {
  if (id === undefined) return [];
  return roles.filter((list) => list.executors.includes(id)).map((list) => list.role);
}

/** The roles the preset of the run gives a row (its Executor `<alias>-<effort>@<account>`). */
export function presetRowRoles(run: SetupRunView | undefined, row: ExecutorRow): RowRole[] {
  return rolesOfId(presetRolesOf(run?.done ?? []), presetIdOf(row));
}

/** The roles beside a row: the ones the person chose (N335), or the preset's. */
export function rowRoles(run: SetupRunView | undefined, row: ExecutorRow): readonly RowRole[] {
  return row.roles ?? presetRowRoles(run, row);
}

/**
 * N335: the place of a row in the list of each of its roles, from 1, as the preset has it. A role
 * the person added to the row has no place yet (`null`): the Executor enters at the end of that
 * list, and the review shows where.
 */
export function rowPositions(
  run: SetupRunView | undefined,
  row: ExecutorRow,
): { role: RowRole; position: number | null }[] {
  const lists = presetRolesOf(run?.done ?? []);
  const id = presetIdOf(row);
  return rowRoles(run, row).map((role) => {
    const at =
      id === undefined
        ? -1
        : (lists.find((list) => list.role === role)?.executors.indexOf(id) ?? -1);
    return { role, position: at < 0 ? null : at + 1 };
  });
}

/** What the catalogs found for the preset in this run (the `discovered` of the done steps). */
export function discoveredOfRun(done: readonly SetupDoneStep[]): SetupExecutor[] {
  const found: SetupExecutor[] = [];
  for (const step of done) {
    if (step.step === 'preset' || step.step === 'account') found.push(...step.output.discovered);
  }
  return found;
}

/** The accounts the run took in, in order (the detection's, or the one of the flow). */
export function accountsOfRun(done: readonly SetupDoneStep[]): string[] {
  for (const step of done) {
    if (step.step === 'detect') return [...step.output.accounts];
    if (step.step === 'account') return [step.output.profile.profileId];
  }
  return [];
}
