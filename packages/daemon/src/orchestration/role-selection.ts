// SPDX-License-Identifier: MPL-2.0
import {
  hasErrorCode,
  selectExecutorFromPorts,
  type Clock,
  type ExecutorConfig,
  type JsonObject,
  type JsonValue,
  type Profile,
  type ProfileFact,
  type ResolvedExecutor,
  type ResolvedRoles,
  type SelectionPorts,
  type SelectionResult,
  type SelectionSettings,
  type SkipReason,
  type Store,
  type WorkedBy,
} from '@otheater/core';
import {
  buildDaemonEvent,
  type ScenarioSelectionWaitNotice,
  type SelectionWaitOutcome,
} from '@otheater/protocol';
import type { DaemonConfig } from '../config.js';
import { attemptIdOf } from '../execution/attempt-runner.js';
import type { SessionPool } from '../execution/pool.js';
import type { Logger } from '../logger.js';
import type { DataPaths } from '../paths.js';
import type { QuotaService } from '../quota/service.js';
import { executorSelectedPayload, quotaFactOf, selectionSettingsOf } from './executor-selection.js';
import { resolveScenarioRoleExecutors } from './role-executors.js';
import { sessionSettingsOf } from './roles.js';

/**
 * The selection of the Executor in the pipeline (architecture 5.7; Phase 5, P16): what takes the
 * place of the fixed `orchestration.executor`. For each demand of a role it resolves the list of
 * the role for the scenario (P13: the configuration, the override of the scenario and of the task,
 * `allowed_profiles`), asks the ports (the quota of P5, the slots of the pool of P4, the profile of
 * P2) and runs the pure selector of P15. The result is kept (the Executor and the
 * `executor.selected` payload on the blackboard of the play, the event in the log), and a demand
 * with nobody available waits here, with the reason, until the wake of P9 (`quota.restored`) or the
 * recheck brings somebody back.
 *
 * The configuration is read at each selection and nothing else holds on to it: a session that is
 * already open keeps the Executor it was given, whatever the configuration says afterwards.
 *
 * [proposta] Where the record of a selection lives: the attempt row has no Executor column and only
 * P1 touches the migrations, so each selection is the value of the blackboard key
 * `selection/<demand>/<attempt>` of the play and, with the event, is tied to the attempt id.
 */

/** The blackboard key of the selection of one attempt. */
export function selectionKey(demandId: string, attempt: number): string {
  return `selection/${demandId}/${String(attempt)}`;
}

/** The blackboard key of the last Executor that did the work of a role (for the cross-review). */
export function workedKey(role: string): string {
  return `selection/worked/${role}`;
}

/** The role whose work a role judges (5.7, "revisão cruzada"): the Reviewer reads the plan. */
const REVIEWED_ROLE: Readonly<Record<string, string>> = { reviewer: 'author', critic: 'actor' };

export interface RoleSelectionOptions {
  readonly store: Pick<Store, 'profiles' | 'scenarios' | 'blackboard' | 'events'>;
  readonly config: DaemonConfig;
  readonly quota: Pick<QuotaService, 'statusOf'>;
  readonly pool: Pick<SessionPool, 'slotOf'>;
  readonly paths: Pick<DataPaths, 'profiles'>;
  readonly clock: Clock;
  readonly logger: Logger;
  /**
   * The N135 notice (`selection.strict_unavailable: wait_notify`): called once for each wait of a
   * scenario that the strict cross-review causes, after the `scenario.system_message` event is
   * written. The daemon hands it to the Producer channel; absent, the event is the only record.
   */
  readonly onNotice?: ((notice: ScenarioSelectionWaitNotice) => void) | undefined;
}

/** What a caller asks for: the Executor of `role` for one piece of work. */
export interface RoleSelectionRequest {
  readonly role: string;
  /** The scenario whose `configOverride` chain applies; absent: the daemon configuration alone. */
  readonly scenarioId?: string | undefined;
  /** The override of a scheduled task (Phase 6), the strongest layer. */
  readonly taskOverride?: JsonObject | undefined;
  /** The attempt this selection is for, when it is one of a play. */
  readonly attempt?: {
    readonly playId: string;
    readonly demandId: string;
    readonly number: number;
  };
  /** The prompt in tokens, when the caller knows it, for the check of the window. */
  readonly promptTokens?: number | undefined;
  /** Who did the work under review; absent: the selection reads the last one the play recorded. */
  readonly workedBy?: WorkedBy | null | undefined;
  /** A requirement of the caller on top of the list: a reason to leave an Executor out, or null. */
  readonly refuse?: ((executor: ResolvedExecutor) => string | null) | undefined;
}

/** What the caller runs the session with. */
export interface SelectedExecutor {
  readonly executor: ResolvedExecutor;
  readonly profile: Profile;
  readonly settings: ExecutorConfig;
  readonly result: SelectionResult;
}

/** One demand that waits for an Executor (what the Director's `status` and the chat show). */
export interface RoleWait {
  readonly role: string;
  readonly scenarioId: string | null;
  readonly playId: string | null;
  readonly demandId: string | null;
  /** What the role waits on, each with the reason (`quota`, `budget`, `no_slot`...). */
  readonly on: readonly {
    readonly executor: string;
    readonly profile: string;
    readonly reason: SkipReason;
  }[];
  /** The earliest known end (epoch ms), or null. */
  readonly until: number | null;
  readonly since: number;
  /** "waiting for quota of claude-code/a, claude-code/b" */
  readonly message: string;
}

/** How a wait that {@link RoleSelection.acquire} held ended. */
export interface WaitEnd {
  readonly outcome: SelectionWaitOutcome;
  /** The Executor chosen (`outcome: selected`), or null. */
  readonly executor: string | null;
  readonly waitedMs: number;
  /** The wait as it stood when it ended. */
  readonly wait: RoleWait;
}

/**
 * What a caller hears of the wait of its `acquire` (P16b): `started` once, when the first
 * selection finds nobody and the call begins to wait; `ended` once, when it stops waiting for
 * whatever reason. A call that finds an Executor at the first try hears neither. A callback that
 * throws is logged and does not change the selection.
 */
export interface AcquireWatch {
  readonly started?: (wait: RoleWait) => void | Promise<void>;
  readonly ended?: (end: WaitEnd) => void | Promise<void>;
}

export type Acquired =
  | ({ readonly kind: 'selected' } & SelectedExecutor)
  /** Nobody will come back by waiting (an empty list, every Executor invalid): the reason. */
  | { readonly kind: 'unavailable'; readonly reason: string; readonly result: SelectionResult };

const REASON_TEXT: Readonly<Record<string, string>> = {
  quota: 'quota',
  budget: 'the spending cap',
  no_slot: 'a free slot',
  ram: 'free RAM',
  unhealthy: 'a healthy profile',
};

/** "quota of claude-code/a, claude-code/b; a free slot of codex/c". */
export function describeWait(on: RoleWait['on']): string {
  const groups = new Map<string, string[]>();
  for (const item of on) {
    const list = groups.get(item.reason) ?? [];
    if (!list.includes(item.profile)) list.push(item.profile);
    groups.set(item.reason, list);
  }
  const parts = [...groups].map(
    ([reason, profiles]) => `${REASON_TEXT[reason] ?? reason} of ${profiles.join(', ')}`,
  );
  return `waiting for ${parts.join('; ')}`;
}

/** What a selection with nobody waits on: the skipped Executors time can bring back, each with its reason. */
function waitOn(result: SelectionResult): RoleWait['on'] {
  return (result.wait?.on ?? []).flatMap((id) => {
    const skipped = result.skipped.find((item) => item.executor === id);
    return skipped === undefined
      ? []
      : [{ executor: id, profile: skipped.profile, reason: skipped.reason }];
  });
}

/** Why a selection that found nobody and will not find anybody by waiting found nobody. */
function unavailableText(role: string, result: SelectionResult): string {
  if (result.skipped.length === 0) {
    return `No Executor is configured for the ${role}: name some in roles.${role}.executors, or set orchestration.executor.`;
  }
  const why = result.skipped
    .map(
      (item) =>
        `${item.executor} (${item.reason}${item.detail === null ? '' : `: ${item.detail}`})`,
    )
    .join('; ');
  return `No Executor of the ${role} can take the work: ${why}.`;
}

/** What one `acquire` remembers of its own wait. */
interface AcquireRun {
  /** When the wait began; undefined while nothing has waited. */
  since: number | undefined;
  last: RoleWait | undefined;
  notified: boolean;
  ended: boolean;
}

interface WaitState {
  readonly wait: RoleWait;
  /** The signature that decides whether the waiting event is said again. */
  readonly signature: string;
}

export class RoleSelection {
  readonly #options: RoleSelectionOptions;
  /** `round_robin`: where the next demand of a group starts, by scope and role (not kept across a restart). */
  readonly #cursors = new Map<string, Map<string, number>>();
  readonly #waits = new Map<string, WaitState>();
  readonly #wakers = new Set<() => void>();
  readonly #closing = new AbortController();
  #epoch = 0;
  #sequence = 0;

  constructor(options: RoleSelectionOptions) {
    this.#options = options;
  }

  /** The demands that wait for an Executor now, oldest first; `scenarioId` narrows to one scenario. */
  waiting(scenarioId?: string): readonly RoleWait[] {
    return [...this.#waits.values()]
      .map((state) => state.wait)
      .filter((wait) => scenarioId === undefined || wait.scenarioId === scenarioId)
      .sort((a, b) => a.since - b.since);
  }

  /**
   * Somebody may be available now (`quota.restored`, a slot that freed): every demand that waits
   * looks again. Idempotent; the hook of P9 calls it for every restored profile.
   */
  wake(): void {
    this.#epoch += 1;
    for (const waker of [...this.#wakers]) waker();
  }

  /** Releases every wait (the daemon is stopping). They end as `undefined`. */
  close(): void {
    this.#closing.abort();
    this.wake();
  }

  /**
   * One selection, with no waiting: the result of the selector, kept (the event and, for an
   * attempt of a play, the record). A role with nobody available is not registered as waiting:
   * the caller decides what to do with the answer (see {@link once}).
   */
  async select(request: RoleSelectionRequest): Promise<SelectionResult> {
    return this.#selectKeeping(request, null);
  }

  /**
   * One selection for a caller that does not wait (the Consultant, the Author of an idea, a
   * Director with `selection.director_wait: fail`): the Executor, or why there is none, with the
   * "waiting for quota of ..." text when time could bring somebody back.
   */
  async once(
    request: RoleSelectionRequest,
  ): Promise<
    | Acquired
    | { readonly kind: 'waiting'; readonly reason: string; readonly result: SelectionResult }
  > {
    const result = await this.select(request);
    if (result.selected !== null) {
      return { kind: 'selected', ...this.#settingsOf(request, result.selected, result) };
    }
    const on = waitOn(result);
    if (on.length === 0) {
      return { kind: 'unavailable', reason: unavailableText(request.role, result), result };
    }
    return { kind: 'waiting', reason: describeWait(on), result };
  }

  async #selectKeeping(
    request: RoleSelectionRequest,
    key: string | null,
  ): Promise<SelectionResult> {
    const result = await this.#decide(request);
    await this.#keep(request, result, key);
    return result;
  }

  /**
   * The Executor of the role, waiting for one while there is hope (a quota that comes back, a slot
   * that frees): until the selector chooses, `signal` aborts or the service closes (`undefined`).
   * It does not wait for what time cannot fix: an empty list or Executors that are all invalid
   * give `unavailable` at once, with the reason.
   */
  async acquire(
    request: RoleSelectionRequest,
    options: { readonly signal?: AbortSignal; readonly watch?: AcquireWatch } = {},
  ): Promise<Acquired | undefined> {
    const key = this.#waitKey(request);
    const run: AcquireRun = { since: undefined, last: undefined, notified: false, ended: false };
    let acquired: Acquired | undefined;
    try {
      acquired = await this.#acquireLoop(request, key, options, run);
      return acquired;
    } finally {
      this.#waits.delete(key);
      await this.#ended(
        options.watch,
        run,
        acquired === undefined ? 'cancelled' : acquired.kind,
        acquired?.kind === 'selected' ? acquired.executor.id : null,
      );
    }
  }

  async #acquireLoop(
    request: RoleSelectionRequest,
    key: string,
    options: { readonly signal?: AbortSignal; readonly watch?: AcquireWatch },
    run: AcquireRun,
  ): Promise<Acquired | undefined> {
    for (;;) {
      if (this.#cancelled(options.signal)) return undefined;
      const epoch = this.#epoch;
      const result = await this.#selectKeeping(request, key);
      if (result.selected !== null) {
        return { kind: 'selected', ...this.#settingsOf(request, result.selected, result) };
      }
      if (waitOn(result).length === 0) {
        return { kind: 'unavailable', reason: unavailableText(request.role, result), result };
      }
      const wait = this.#waits.get(key)?.wait;
      if (wait !== undefined) {
        run.last = wait;
        if (run.since === undefined) {
          run.since = wait.since;
          await this.#guard('the wait watcher (started)', () => options.watch?.started?.(wait));
        }
        if (!run.notified && this.#asksNotice(result)) {
          run.notified = true;
          await this.#notice(request, result, wait);
        }
      }
      if (epoch !== this.#epoch) continue; // somebody woke us while we were deciding
      await this.#park(options.signal);
    }
  }

  /** Tells the watcher the wait is over, once, when there was a wait. */
  async #ended(
    watch: AcquireWatch | undefined,
    run: AcquireRun,
    outcome: SelectionWaitOutcome,
    executor: string | null,
  ): Promise<void> {
    if (run.since === undefined || run.last === undefined || run.ended) return;
    run.ended = true;
    const end: WaitEnd = {
      outcome,
      executor,
      waitedMs: Math.max(0, this.#options.clock.now() - run.since),
      wait: run.last,
    };
    await this.#guard('the wait watcher (ended)', () => watch?.ended?.(end));
  }

  /** A hook of the caller must not break the selection: its failure is logged. */
  async #guard(what: string, call: () => unknown): Promise<void> {
    try {
      await call();
    } catch (error) {
      this.#options.logger.error({ err: error }, `${what} failed`);
    }
  }

  /** N135: the wait is the strict cross-review's and the settings ask for the Producer to know. */
  #asksNotice(result: SelectionResult): boolean {
    const { config } = this.#options;
    return (
      result.wait?.notify === true ||
      (result.crossCheck.blocked && config.selection.strict_unavailable === 'wait_notify')
    );
  }

  /** Writes the `scenario.system_message` of N135 and hands it to the channel. */
  async #notice(
    request: RoleSelectionRequest,
    result: SelectionResult,
    wait: RoleWait,
  ): Promise<void> {
    const { scenarioId } = request;
    if (scenarioId === undefined) return; // no chat to tell
    const notice: ScenarioSelectionWaitNotice = {
      scenarioId,
      kind: 'selection_wait',
      role: request.role,
      playId: wait.playId,
      demandId: wait.demandId,
      crossCheck: result.crossCheck.mode,
      workedProvider: result.crossCheck.workedProvider,
      on: wait.on.map((item) => ({ ...item })),
      until: wait.until,
    };
    await this.#guard('the notice of the wait', async () => {
      await this.#options.store.events.append({
        ...buildDaemonEvent('scenario.system_message', notice),
        scenarioId,
        ...(wait.playId === null ? {} : { playId: wait.playId }),
      });
      this.#options.onNotice?.(notice);
    });
  }

  /** The session settings of an Executor of a selection (the profile and the model it runs with). */
  settingsOf(
    request: RoleSelectionRequest,
    executor: ResolvedExecutor,
    result: SelectionResult,
  ): SelectedExecutor {
    return this.#settingsOf(request, executor, result);
  }

  // ---- the decision ----

  /**
   * The facts the selector reads and the lists of the roles for a scenario, as they are now. The
   * same snapshot serves the selection of a demand and the handoff of an attempt (P18).
   */
  async #inputs(
    scenarioId: string | undefined,
    taskOverride: RoleSelectionRequest['taskOverride'],
    director: boolean,
  ): Promise<{ readonly ports: SelectionPorts; readonly resolved: ResolvedRoles }> {
    const { config, store, quota, pool, paths } = this.#options;
    const profiles = await this.#profileFacts();
    const resolved = await resolveScenarioRoleExecutors(
      { config, scenarios: store.scenarios },
      { profiles },
      scenarioId,
      taskOverride,
    );
    const ports: SelectionPorts = {
      profile: (id) => profiles.find((profile) => profile.id === id),
      // [proposta] No source tells the daemon that a profile is unhealthy yet: a login that lapsed
      // shows as a failed attempt (P17), not as a probe.
      health: () => true,
      quota: async (id) => quotaFactOf(await quota.statusOf(id)),
      admission: (executor) => ({
        slot: pool.slotOf(
          sessionSettingsOf(paths, {
            client: executor.entry.client,
            profile: executor.entry.profile,
            model: executor.entry.model,
          }).profile,
          director,
        ),
        ram: 'ok',
      }),
      contextWindow: () => undefined,
    };
    return { ports, resolved };
  }

  /**
   * What the handoff of an attempt (P18) needs to choose the next Executor with the same selector
   * and the same facts: the ports, the settings and the lists of the roles of the scenario.
   */
  async selectorInputs(scenarioId: string | undefined): Promise<{
    readonly ports: SelectionPorts;
    readonly settings: SelectionSettings;
    readonly roles: ResolvedRoles['roles'];
  }> {
    const { ports, resolved } = await this.#inputs(scenarioId, undefined, false);
    return { ports, settings: selectionSettingsOf(this.#options.config), roles: resolved.roles };
  }

  /** The profile and the settings of the session of an Executor of a role (the handoff's launch). */
  sessionOf(
    role: string,
    executor: ResolvedExecutor,
  ): { readonly profile: Profile; readonly settings: ExecutorConfig } {
    return this.#sessionOf(role, executor);
  }

  async #decide(request: RoleSelectionRequest): Promise<SelectionResult> {
    const { config } = this.#options;
    const { ports, resolved } = await this.#inputs(
      request.scenarioId,
      request.taskOverride,
      request.role === 'director',
    );
    const role = (
      resolved.roles as Readonly<
        Record<string, (typeof resolved.roles)[keyof typeof resolved.roles]>
      >
    )[request.role];
    if (role === undefined) {
      return emptyResult(
        request.role,
        selectionSettingsOf(config).strategy,
        selectionSettingsOf(config),
      );
    }
    const executors =
      request.refuse === undefined
        ? role.executors
        : role.executors.map((item): ResolvedExecutor => {
            if (item.validity === 'invalid') return item;
            const reason = request.refuse?.(item) ?? null;
            return reason === null ? item : { ...item, validity: 'invalid', invalidReason: reason };
          });
    const roundRobin = this.#cursors.get(this.#scopeOf(request));
    const previousExecutor = await this.#previousOf(request);
    const workedBy =
      request.workedBy !== undefined ? request.workedBy : await this.#workedByOf(request);
    return selectExecutorFromPorts(ports, {
      role: { role: role.role, executors, whenExhausted: role.whenExhausted },
      settings: selectionSettingsOf(config),
      promptTokens: request.promptTokens,
      previousExecutor,
      workedBy,
      roundRobin,
    });
  }

  /**
   * The profiles of the registry as facts, plus the ones the old keys name that nobody registered
   * (`selection.unregistered_profiles: allow`): until P16 the pipeline ran what
   * `orchestration.executor` said whether or not the account was in the registry, and it still does.
   */
  async #profileFacts(): Promise<ProfileFact[]> {
    const { store, config } = this.#options;
    const facts: ProfileFact[] = (await store.profiles.list()).map((record) => ({
      id: record.id,
      kind: record.kind,
      state: record.state,
    }));
    if (config.selection.unregistered_profiles === 'refuse') return facts;
    const known = new Set(facts.map((fact) => fact.id));
    const legacy = [config.orchestration.executor, ...Object.values(config.orchestration.roles)];
    for (const executor of legacy) {
      if (executor === undefined) continue;
      const id = `${executor.client}/${executor.profile}`;
      if (known.has(id)) continue;
      known.add(id);
      facts.push({ id, kind: 'token_plan', state: 'active' });
    }
    return facts;
  }

  #settingsOf(
    request: RoleSelectionRequest,
    executor: ResolvedExecutor,
    result: SelectionResult,
  ): SelectedExecutor {
    return { executor, ...this.#sessionOf(request.role, executor), result };
  }

  #sessionOf(
    role: string,
    executor: ResolvedExecutor,
  ): { readonly profile: Profile; readonly settings: ExecutorConfig } {
    const { config, paths } = this.#options;
    // `mode` is the one field of the old key the new name cannot carry.
    const legacy =
      executor.origin === 'legacy'
        ? (config.orchestration.roles[role] ?? config.orchestration.executor)
        : undefined;
    const { profile, executor: settings } = sessionSettingsOf(paths, {
      client: executor.entry.client,
      profile: executor.entry.profile,
      model: executor.entry.model,
      ...(executor.entry.effort === null ? {} : { effort: executor.entry.effort }),
      ...(legacy?.mode === undefined ? {} : { mode: legacy.mode }),
    });
    return { profile, settings };
  }

  // ---- what the pipeline keeps ----

  async #previousOf(request: RoleSelectionRequest): Promise<string | null> {
    const { attempt } = request;
    if (attempt === undefined || attempt.number <= 1) return null;
    const entry = await this.#options.store.blackboard.get(
      attempt.playId,
      selectionKey(attempt.demandId, attempt.number - 1),
    );
    const value = entry?.value;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    return typeof value.executor === 'string' ? value.executor : null;
  }

  async #workedByOf(request: RoleSelectionRequest): Promise<WorkedBy | null> {
    const reviewed = REVIEWED_ROLE[request.role];
    if (reviewed === undefined || request.attempt === undefined) return null;
    const entry = await this.#options.store.blackboard.get(
      request.attempt.playId,
      workedKey(reviewed),
    );
    const value = entry?.value;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    if (typeof value.provider !== 'string') return null;
    return {
      provider: value.provider,
      ...(typeof value.model === 'string' ? { model: value.model } : {}),
      ...(typeof value.effort === 'string' || value.effort === null
        ? { effort: value.effort }
        : {}),
      ...(typeof value.profile === 'string' ? { profile: value.profile } : {}),
    };
  }

  /** `key` is the wait registry entry of the piece of work, or null for a selection that never waits. */
  async #keep(
    request: RoleSelectionRequest,
    result: SelectionResult,
    key: string | null,
  ): Promise<void> {
    const { store, clock, logger } = this.#options;
    const now = clock.now();
    const attempt = request.attempt;
    const payload = executorSelectedPayload(result, { playId: attempt?.playId ?? null, now });
    if (result.roundRobin !== null) {
      const scope = this.#scopeOf(request);
      const cursors = this.#cursors.get(scope) ?? new Map<string, number>();
      cursors.set(result.roundRobin.group, result.roundRobin.cursor);
      this.#cursors.set(scope, cursors);
    }
    let say = true;
    if (key === null) {
      // nothing to register
    } else if (result.selected === null) {
      const on = waitOn(result);
      const signature = JSON.stringify([result.wait?.mode, on]);
      const previous = this.#waits.get(key);
      say = previous?.signature !== signature;
      if (on.length > 0) {
        this.#waits.set(key, {
          signature,
          wait: {
            role: request.role,
            scenarioId: request.scenarioId ?? null,
            playId: attempt?.playId ?? null,
            demandId: attempt?.demandId ?? null,
            on,
            until: result.wait?.until ?? null,
            since: previous?.wait.since ?? now,
            message: describeWait(on),
          },
        });
      } else {
        this.#waits.delete(key);
      }
    } else {
      this.#waits.delete(key);
    }
    try {
      if (result.selected !== null && attempt !== undefined) {
        const value: JsonObject = {
          role: request.role,
          executor: result.selected.id,
          profile: `${result.selected.entry.client}/${result.selected.entry.profile}`,
          provider: result.selected.entry.provider,
          model: result.selected.entry.model,
          attempt: attempt.number,
          selectedAt: now,
          event: toJson(payload),
        };
        await store.blackboard.put({
          playId: attempt.playId,
          key: selectionKey(attempt.demandId, attempt.number),
          value,
          author: 'daemon',
        });
        await store.blackboard.put({
          playId: attempt.playId,
          key: workedKey(request.role),
          value: {
            executor: result.selected.id,
            profile: `${result.selected.entry.client}/${result.selected.entry.profile}`,
            provider: result.selected.entry.provider,
            model: result.selected.entry.model,
            effort: result.selected.entry.effort,
          },
          author: 'daemon',
        });
      }
      if (!say) return;
      await store.events.append({
        ...buildDaemonEvent('executor.selected', payload),
        ...(request.scenarioId === undefined ? {} : { scenarioId: request.scenarioId }),
        ...(attempt === undefined
          ? {}
          : {
              playId: attempt.playId,
              attemptId: attemptIdOf(attempt.playId, attempt.demandId, attempt.number),
            }),
      });
    } catch (error) {
      // The record is for the Producer and the retry; losing it must not lose the demand.
      logger.error(
        { err: error, role: request.role },
        'the selection of an Executor was not recorded',
      );
    }
  }

  // ---- waiting ----

  #cancelled(signal: AbortSignal | undefined): boolean {
    return this.#closing.signal.aborted || signal?.aborted === true;
  }

  #scopeOf(request: RoleSelectionRequest): string {
    return `${request.scenarioId ?? ''}|${request.role}`;
  }

  /** One key per piece of work that waits; a selection with no attempt gets its own. */
  #waitKey(request: RoleSelectionRequest): string {
    const { attempt } = request;
    if (attempt !== undefined) return `${attempt.playId}/${attempt.demandId}`;
    this.#sequence += 1;
    return `${request.scenarioId ?? ''}|${request.role}|${String(this.#sequence)}`;
  }

  /** Sleeps until a wake, the recheck, an abort or the close. */
  async #park(signal: AbortSignal | undefined): Promise<void> {
    const { clock, config } = this.#options;
    const local = new AbortController();
    const stop = AbortSignal.any([
      local.signal,
      this.#closing.signal,
      ...(signal === undefined ? [] : [signal]),
    ]);
    const waker = (): void => {
      local.abort();
    };
    this.#wakers.add(waker);
    try {
      if (config.selection.recheck_every > 0) {
        await clock.sleep(config.selection.recheck_every, stop);
      } else if (!stop.aborted) {
        await new Promise<void>((resolve) => {
          stop.addEventListener(
            'abort',
            () => {
              resolve();
            },
            { once: true },
          );
        });
      }
    } catch (error) {
      if (!hasErrorCode(error, 'CANCELLED')) throw error;
    } finally {
      this.#wakers.delete(waker);
    }
  }
}

function toJson(value: object): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

/** The result of a role the registry does not know: nobody, and nothing to wait for. */
function emptyResult(
  role: string,
  strategy: SelectionResult['strategy'],
  settings: { readonly crossCheck: SelectionResult['crossCheck']['mode'] },
): SelectionResult {
  return {
    role: role as SelectionResult['role'],
    selected: null,
    wait: { mode: 'next', on: [], until: null, notify: false },
    skipped: [],
    strategy,
    retriedAfter: null,
    crossCheck: {
      mode: settings.crossCheck,
      applied: false,
      workedProvider: null,
      fellBack: false,
      noneConfigured: false,
      degraded: null,
      sameAccount: false,
      blocked: false,
    },
    roundRobin: null,
  };
}
