// SPDX-License-Identifier: MPL-2.0
import { InvalidInput } from '../errors.js';
import type { RoleId } from '../registries/roles.js';
import type { WhenExhausted } from './presets.js';
import type { ProfileFact, ResolvedExecutor, ResolvedRole } from './resolve.js';

/**
 * The selection of an Executor for a role (architecture 5.7, "Algoritmo"; Phase 5, P15), as a pure
 * function. Nothing here reads the store, a client or the clock: the caller gathers the facts of
 * each Executor through the ports below (`gatherSelectionFacts`) and hands them in, with who did
 * the work and the attempt before. The pipeline does not call it yet (P16).
 *
 * The steps of 5.7, in the order the code applies them:
 * 1. the list of the role, in order. `selection.strategy` reorders only the Executors of the same
 *    `<model>-<effort>` that sit side by side (contiguous), so the order between models never
 *    changes (N130) [proposta: contiguous];
 * 2. retry with diversity: a new attempt of a demand that failed starts at the Executor after the
 *    one of the previous attempt;
 * 3. `selection.near_limit: last` moves the Executors near their limit to the end (N124);
 * 4. the cross-review (`selection.cross_check`) puts the Executors of the same provider as who did
 *    the work aside, for the Reviewer and the Critic;
 * 5. the first Executor that is available wins; with none, the result says what to wait for
 *    (`next`: whichever frees first; `wait`: the reset of the first, with no demotion).
 */

/** `selection.strategy` (5.7, N130): the order among the accounts of one `<model>-<effort>`. */
export const SELECTION_STRATEGIES = ['ordered', 'most_headroom', 'round_robin'] as const;
export type SelectionStrategy = (typeof SELECTION_STRATEGIES)[number];

/** `selection.cross_check` (5.7). */
export const CROSS_CHECK_MODES = [
  'prefer_other_provider',
  'require_other_provider',
  'other_model',
  'off',
] as const;
export type CrossCheckMode = (typeof CROSS_CHECK_MODES)[number];

/** The roles the cross-review applies to: the Reviewer and the Critic judge somebody's work (5.7). */
export const CROSS_CHECK_ROLES = ['reviewer', 'critic'] as const satisfies readonly RoleId[];

/** `selection.unknown_quota` [proposta, N124]: what to do with a profile whose quota is `unknown`. */
export const UNKNOWN_QUOTA_MODES = ['allow', 'skip'] as const;
export type UnknownQuotaMode = (typeof UNKNOWN_QUOTA_MODES)[number];

/** `selection.near_limit` [proposta, N124]: where a profile in `near_limit` goes in the order. */
export const NEAR_LIMIT_MODES = ['keep_order', 'last', 'skip'] as const;
export type NearLimitMode = (typeof NEAR_LIMIT_MODES)[number];

/**
 * `selection.retry_diversity` [proposta]: how a retry starts after the Executor that failed.
 * `rotate` (default, the 5.7 rule): at the next Executor of the list, and the one that failed goes
 * to the end, so a list with one more candidate than the failed one never runs dry. `forward_only`:
 * only the Executors after the one that failed (the list ends sooner). `off`: no diversity, the
 * list from the top.
 */
export const RETRY_DIVERSITY_MODES = ['rotate', 'forward_only', 'off'] as const;
export type RetryDiversityMode = (typeof RETRY_DIVERSITY_MODES)[number];

/** The settings of the selection, as the `selection` block of the configuration gives them. */
export interface SelectionSettings {
  readonly strategy: SelectionStrategy;
  readonly crossCheck: CrossCheckMode;
  readonly unknownQuota: UnknownQuotaMode;
  readonly nearLimit: NearLimitMode;
  readonly retryDiversity: RetryDiversityMode;
  /**
   * Tokens the client keeps in the window for its own system prompt and tools; the prompt of the
   * demand plus this must fit the window of the Executor (5.7, "com a folga do cliente"). 0 until
   * somebody measures it [proposta].
   */
  readonly contextReserve: number;
}

/** The defaults of `selection`: the 5.7 behaviour, and N124's `allow` and `keep_order`. */
export const DEFAULT_SELECTION_SETTINGS: SelectionSettings = {
  strategy: 'ordered',
  crossCheck: 'prefer_other_provider',
  unknownQuota: 'allow',
  nearLimit: 'keep_order',
  retryDiversity: 'rotate',
  contextReserve: 0,
};

/**
 * Why an Executor was passed over. The first eight are the ones 5.7 names [proposta]; `unhealthy`,
 * `same_model` and `retry` are the cases the algorithm has and the list of 5.7 does not name.
 * `quota` covers a profile out of quota, one whose quota is unknown or near its limit when the
 * settings say to skip (`detail` tells which).
 */
export const SKIP_REASONS = [
  'quota',
  'budget',
  'draining',
  'invalid',
  'no_slot',
  'ram',
  'context',
  'same_provider',
  'same_model',
  'unhealthy',
  'retry',
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

/**
 * The reasons that can pass with time: a wait for a reset or for a vacancy may end with this
 * Executor (`wait` and `next` only look at these). The others (a profile draining, an Executor
 * invalid, a prompt too big, the same provider, a retry that excludes it) never change by waiting.
 */
export const TEMPORARY_SKIP_REASONS = [
  'quota',
  'budget',
  'no_slot',
  'ram',
  'unhealthy',
] as const satisfies readonly SkipReason[];

// ---------------------------------------------------------------------------------------------
// What the ports say about an Executor.
// ---------------------------------------------------------------------------------------------

/** The quota of a profile as the `QuotaService` reports it (5.6). */
export interface QuotaFact {
  readonly state: 'ok' | 'near_limit' | 'exhausted' | 'unknown';
  /** Why it is `exhausted`; null in any other state. */
  readonly cause: 'quota' | 'budget' | null;
  /** Until when it is exhausted (epoch ms); null when no source says. */
  readonly untilReset: number | null;
  /** Free fraction of the fullest window, 0 to 1; null when it is not known. */
  readonly headroom: number | null;
}

/** What the pool says of a new session of the Executor (5.9, P4). */
export interface AdmissionFact {
  readonly slot: 'free' | 'full';
  /**
   * `low` when the RAM does not hold another session. The port applies `pool.admission.mode` and
   * `unknown_ram`: with `mode: slots`, or a probe that cannot tell and `unknown_ram: admit`, it is
   * `ok`.
   */
  readonly ram: 'ok' | 'low';
}

/** Everything the selection asks about one Executor. */
export interface ExecutorFacts {
  /** `missing` when the profile of the Executor is not registered. */
  readonly profileState: ProfileFact['state'] | 'missing';
  /** The profile answers (a local server is up, a login holds). */
  readonly healthy: boolean;
  readonly quota: QuotaFact;
  readonly admission: AdmissionFact;
  /** Context window in tokens (per slot for a local model); undefined when nobody says. */
  readonly contextWindow?: number | undefined;
}

type Awaitable<T> = T | Promise<T>;

/** The ports the selection reads, one question each. The daemon wires them to P2, P4 and P5. */
export interface SelectionPorts {
  /** The registered profile `<client>/<profile>`, or undefined. */
  profile(profileId: string): Awaitable<Pick<ProfileFact, 'state'> | undefined>;
  health(profileId: string): Awaitable<boolean>;
  /** The `QuotaService.statusOf` of the profile (never `canUse`: `unknown` is the policy's call). */
  quota(profileId: string): Awaitable<QuotaFact>;
  admission(executor: ResolvedExecutor): Awaitable<AdmissionFact>;
  contextWindow(executor: ResolvedExecutor): Awaitable<number | undefined>;
}

/**
 * Asks the ports about every Executor that is not already invalid. A profile is asked once however
 * many Executors it has. A port that rejects makes this reject: the selection never guesses.
 */
export async function gatherSelectionFacts(
  ports: SelectionPorts,
  executors: readonly ResolvedExecutor[],
): Promise<Map<string, ExecutorFacts>> {
  const byProfile = new Map<
    string,
    Promise<{ state: ExecutorFacts['profileState']; healthy: boolean; quota: QuotaFact }>
  >();
  const profileFacts = (profileId: string) => {
    let known = byProfile.get(profileId);
    if (known === undefined) {
      known = (async () => {
        const profile = await ports.profile(profileId);
        const [healthy, quota] = await Promise.all([
          ports.health(profileId),
          ports.quota(profileId),
        ]);
        return { state: profile?.state ?? 'missing', healthy, quota };
      })();
      byProfile.set(profileId, known);
    }
    return known;
  };
  const facts = new Map<string, ExecutorFacts>();
  await Promise.all(
    executors
      .filter((executor) => executor.validity === 'valid')
      .map(async (executor) => {
        const profileId = `${executor.entry.client}/${executor.entry.profile}`;
        const [profile, admission, contextWindow] = await Promise.all([
          profileFacts(profileId),
          ports.admission(executor),
          ports.contextWindow(executor),
        ]);
        facts.set(executor.id, {
          profileState: profile.state,
          healthy: profile.healthy,
          quota: profile.quota,
          admission,
          contextWindow,
        });
      }),
  );
  return facts;
}

// ---------------------------------------------------------------------------------------------
// The selection.
// ---------------------------------------------------------------------------------------------

/** Who did the work the Reviewer or the Critic judges (the Author in the plan, the Actor in the code). */
export interface WorkedBy {
  /** The provider of the Executor that did it (the family of the model, 5.7). */
  readonly provider: string;
  /** Its model, for `other_model`. */
  readonly model?: string | undefined;
}

export interface SelectionInput {
  /** The resolved list of the role (`resolveRoleExecutors`), with its `when_exhausted`. */
  readonly role: Pick<ResolvedRole, 'role' | 'executors' | 'whenExhausted'>;
  /** By Executor id; every Executor that is not `invalid` needs an entry (`gatherSelectionFacts`). */
  readonly facts: ReadonlyMap<string, ExecutorFacts>;
  readonly settings: SelectionSettings;
  /** The prompt of the demand in tokens, estimated by the caller; absent: the window is not checked. */
  readonly promptTokens?: number | undefined;
  /** The Executor of the attempt that failed, when this is a retry. */
  readonly previousExecutor?: string | null | undefined;
  /** Who did the work under review; absent: there is nothing to cross-check. */
  readonly workedBy?: WorkedBy | null | undefined;
  /**
   * `round_robin`: for each `<model>-<effort>`, where the next demand starts in the group (the
   * `roundRobin.cursor` the last selection returned). Absent: 0.
   */
  readonly roundRobin?: ReadonlyMap<string, number> | undefined;
}

export interface SkippedExecutor {
  readonly executor: string;
  /** `<client>/<profile>`. */
  readonly profile: string;
  readonly reason: SkipReason;
  /** What the reason is about (`exhausted`, `unknown`, `near_limit`, `the window is 32000`...). */
  readonly detail: string | null;
  /** When the cause ends (epoch ms), for a quota or budget that says it. */
  readonly untilReset: number | null;
}

/** What the role waits for when nobody is available. */
export interface SelectionWait {
  /** `when_exhausted` of the role: `next` any of `on`; `wait` the reset of the one in `on`. */
  readonly mode: WhenExhausted;
  /** The Executors whose availability may come back, in the order of the list. Empty: none will. */
  readonly on: readonly string[];
  /** The earliest known end among them (epoch ms); null when no source says. */
  readonly until: number | null;
}

export interface SelectionResult {
  readonly role: RoleId;
  /** The Executor chosen; null when the role waits. */
  readonly selected: ResolvedExecutor | null;
  /** Set when `selected` is null. */
  readonly wait: SelectionWait | null;
  /** Every Executor the selection passed over before choosing (or all of them, when it waits). */
  readonly skipped: readonly SkippedExecutor[];
  readonly strategy: SelectionStrategy;
  /** The Executor after which this retry started; null when it is not a retry or it is not in the list. */
  readonly retriedAfter: string | null;
  readonly crossCheck: {
    readonly mode: CrossCheckMode;
    /** The role is cross-checked and there is somebody's work to compare with. */
    readonly applied: boolean;
    readonly workedProvider: string | null;
    /** `prefer_other_provider` found nobody else and went back to the provider of the work. */
    readonly fellBack: boolean;
  };
  /** `round_robin`: the cursor to keep for the group of the chosen Executor; null otherwise. */
  readonly roundRobin: { readonly group: string; readonly cursor: number } | null;
}

/** `<model>-<effort>` of an Executor id: what stands before the `@`. */
function headOf(id: string): string {
  const at = id.indexOf('@');
  return at === -1 ? id : id.slice(0, at);
}

function sameText(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Splits a list into runs of the same `<model>-<effort>`, in order. */
function runsOf(items: readonly ResolvedExecutor[]): ResolvedExecutor[][] {
  const runs: ResolvedExecutor[][] = [];
  for (const item of items) {
    const last = runs[runs.length - 1];
    if (last !== undefined && headOf(last[0]?.id ?? '') === headOf(item.id)) last.push(item);
    else runs.push([item]);
  }
  return runs;
}

/**
 * Selects the Executor of a role for one demand (5.7). Pure: the same input gives the same result.
 * Throws `InvalidInput` when an Executor that is not `invalid` has no facts: a missing answer must
 * not become an availability.
 */
export function selectExecutor(input: SelectionInput): SelectionResult {
  const { role, facts, settings } = input;
  const list = role.executors;
  const profileIdOf = (item: ResolvedExecutor): string =>
    `${item.entry.client}/${item.entry.profile}`;

  for (const item of list) {
    if (item.validity === 'valid' && !facts.has(item.id)) {
      throw new InvalidInput(`selection: no facts for Executor "${item.id}" of role ${role.role}`);
    }
  }
  const factsOf = (item: ResolvedExecutor): ExecutorFacts | undefined => facts.get(item.id);

  // 1. `selection.strategy`, inside each run of one `<model>-<effort>`.
  const cursorOf = (head: string): number => input.roundRobin?.get(head) ?? 0;
  let order: ResolvedExecutor[] = runsOf(list).flatMap((run) => {
    if (run.length < 2) return run;
    if (settings.strategy === 'most_headroom') {
      const room = (item: ResolvedExecutor): number => factsOf(item)?.quota.headroom ?? -1;
      // Array.prototype.sort is stable: a tie keeps the order of the list.
      return [...run].sort((a, b) => room(b) - room(a));
    }
    if (settings.strategy === 'round_robin') {
      const shift = cursorOf(headOf(run[0]?.id ?? '')) % run.length;
      return [...run.slice(shift), ...run.slice(0, shift)];
    }
    return run;
  });

  // 2. Retry with diversity: start after the Executor of the attempt that failed.
  const retrySkipped: ResolvedExecutor[] = [];
  let retriedAfter: string | null = null;
  const previousIndex =
    input.previousExecutor === undefined || input.previousExecutor === null
      ? -1
      : order.findIndex((item) => item.id === input.previousExecutor);
  if (previousIndex !== -1 && settings.retryDiversity !== 'off') {
    retriedAfter = order[previousIndex]?.id ?? null;
    const after = order.slice(previousIndex + 1);
    const upToPrevious = order.slice(0, previousIndex + 1);
    if (settings.retryDiversity === 'rotate') order = [...after, ...upToPrevious];
    else {
      order = after;
      retrySkipped.push(...upToPrevious);
    }
  }

  // 3. `selection.near_limit: last`.
  if (settings.nearLimit === 'last') {
    const near = (item: ResolvedExecutor): boolean => factsOf(item)?.quota.state === 'near_limit';
    order = [...order.filter((item) => !near(item)), ...order.filter(near)];
  }

  // 4. The cross-review: who conflicts with the work under review.
  const crossRole = (CROSS_CHECK_ROLES as readonly string[]).includes(role.role);
  const worked = input.workedBy ?? null;
  const applied = settings.crossCheck !== 'off' && crossRole && worked !== null;
  const strict =
    settings.crossCheck === 'require_other_provider' || settings.crossCheck === 'other_model';
  const conflictReason: SkipReason =
    settings.crossCheck === 'other_model' ? 'same_model' : 'same_provider';
  const conflicts = (item: ResolvedExecutor): boolean => {
    if (!applied || worked === null) return false;
    if (settings.crossCheck === 'other_model') {
      return worked.model !== undefined && sameText(item.entry.model, worked.model);
    }
    // `unknown` counts as different from every provider, itself included (5.7).
    return (
      worked.provider !== 'unknown' &&
      item.entry.provider !== 'unknown' &&
      sameText(item.entry.provider, worked.provider)
    );
  };

  // 5. The availability of each Executor, by the order of the questions of 5.7.
  const verdictOf = (item: ResolvedExecutor): Verdict | null => {
    if (item.validity === 'invalid') {
      return { reason: 'invalid', detail: item.invalidReason, untilReset: null };
    }
    const fact = factsOf(item);
    if (fact === undefined) return { reason: 'invalid', detail: 'no facts', untilReset: null };
    if (fact.profileState === 'missing' || fact.profileState === 'removed') {
      return { reason: 'invalid', detail: `profile ${fact.profileState}`, untilReset: null };
    }
    if (fact.profileState === 'draining') {
      return { reason: 'draining', detail: null, untilReset: null };
    }
    if (!fact.healthy) return { reason: 'unhealthy', detail: null, untilReset: null };
    const { quota } = fact;
    if (quota.state === 'exhausted') {
      return {
        reason: quota.cause === 'budget' ? 'budget' : 'quota',
        detail: 'exhausted',
        untilReset: quota.untilReset,
      };
    }
    if (quota.state === 'unknown' && settings.unknownQuota === 'skip') {
      return { reason: 'quota', detail: 'unknown', untilReset: null };
    }
    if (quota.state === 'near_limit' && settings.nearLimit === 'skip') {
      return { reason: 'quota', detail: 'near_limit', untilReset: quota.untilReset };
    }
    if (fact.admission.slot === 'full')
      return { reason: 'no_slot', detail: null, untilReset: null };
    if (fact.admission.ram === 'low') return { reason: 'ram', detail: null, untilReset: null };
    if (
      input.promptTokens !== undefined &&
      fact.contextWindow !== undefined &&
      input.promptTokens + settings.contextReserve > fact.contextWindow
    ) {
      return {
        reason: 'context',
        detail: `the prompt needs ${String(input.promptTokens + settings.contextReserve)} tokens and the window is ${String(fact.contextWindow)}`,
        untilReset: null,
      };
    }
    return null;
  };

  interface Row {
    readonly item: ResolvedExecutor;
    readonly conflict: boolean;
    readonly verdict: Verdict | null;
  }
  const rows: Row[] = order.map((item) => ({
    item,
    conflict: conflicts(item),
    verdict: verdictOf(item),
  }));

  // 6. The passes: `prefer` tries the others first and then goes back to the provider of the work;
  // the strict modes never use the ones that conflict; otherwise one pass over everything.
  const passes: Row[][] =
    settings.crossCheck === 'prefer_other_provider' && applied
      ? [rows.filter((row) => !row.conflict), rows.filter((row) => row.conflict)]
      : strict
        ? [rows.filter((row) => !row.conflict)]
        : [rows];
  const pick = passes.flat().find((row) => row.verdict === null);
  const chosenIndex = pick === undefined ? -1 : rows.indexOf(pick);
  const fellBack = pick?.conflict === true;

  // What was passed over: every Executor before the chosen one in the order; with a fallback to
  // the provider of the work, also the other providers behind it, which were all unavailable.
  const skipped: SkippedExecutor[] = retrySkipped.map((item) =>
    skip(item, profileIdOf(item), { reason: 'retry', detail: null, untilReset: null }),
  );
  rows.forEach((row, index) => {
    if (row === pick) return;
    const reached = chosenIndex === -1 || index < chosenIndex || (fellBack && !row.conflict);
    if (!reached) return;
    // A conflicting Executor was set aside by the cross-review unless the selection went back to
    // the provider of the work (`prefer`) or found nobody at all after trying them.
    const setAside = row.conflict && (strict || (!fellBack && pick !== undefined));
    const verdict: Verdict | null = setAside
      ? { reason: conflictReason, detail: null, untilReset: null }
      : row.verdict;
    if (verdict !== null) skipped.push(skip(row.item, profileIdOf(row.item), verdict));
  });

  // 7. With nobody: what to wait for (only the reasons that time can end).
  let wait: SelectionWait | null = null;
  if (pick === undefined) {
    const temporary = passes
      .flat()
      .filter(
        (row): row is Row & { verdict: Verdict } =>
          row.verdict !== null &&
          (TEMPORARY_SKIP_REASONS as readonly SkipReason[]).includes(row.verdict.reason),
      );
    const waited = role.whenExhausted === 'wait' ? temporary.slice(0, 1) : temporary;
    const ends = waited.flatMap((row) =>
      row.verdict.untilReset === null ? [] : [row.verdict.untilReset],
    );
    wait = {
      mode: role.whenExhausted,
      on: waited.map((row) => row.item.id),
      until: ends.length === 0 ? null : Math.min(...ends),
    };
  }

  // `round_robin`: the next demand starts after the one that was chosen.
  let roundRobin: SelectionResult['roundRobin'] = null;
  if (settings.strategy === 'round_robin' && pick !== undefined) {
    const run = runsOf(list).find((candidate) => candidate.includes(pick.item));
    if (run !== undefined && run.length > 1) {
      roundRobin = {
        group: headOf(pick.item.id),
        cursor: (run.indexOf(pick.item) + 1) % run.length,
      };
    }
  }

  return {
    role: role.role,
    selected: pick?.item ?? null,
    wait,
    skipped,
    strategy: settings.strategy,
    retriedAfter,
    crossCheck: {
      mode: settings.crossCheck,
      applied,
      workedProvider: applied ? (worked?.provider ?? null) : null,
      fellBack,
    },
    roundRobin,
  };
}

interface Verdict {
  readonly reason: SkipReason;
  readonly detail: string | null;
  readonly untilReset: number | null;
}

function skip(item: ResolvedExecutor, profile: string, verdict: Verdict): SkippedExecutor {
  return {
    executor: item.id,
    profile,
    reason: verdict.reason,
    detail: verdict.detail,
    untilReset: verdict.untilReset,
  };
}

/** `gatherSelectionFacts` and then `selectExecutor`: what a caller with live ports uses. */
export async function selectExecutorFromPorts(
  ports: SelectionPorts,
  input: Omit<SelectionInput, 'facts'>,
): Promise<SelectionResult> {
  const facts = await gatherSelectionFacts(ports, input.role.executors);
  return selectExecutor({ ...input, facts });
}
