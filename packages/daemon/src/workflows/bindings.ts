// SPDX-License-Identifier: MPL-2.0
import {
  type Clock,
  type EventLog,
  InvalidInput,
  NotFound,
  type Store,
  type WorkflowBindingListFilter,
  type WorkflowBindingPatch,
  type WorkflowBindingReason,
  type WorkflowBindingRecord,
  type WorkflowBindingState,
  type WorkflowOnBusy,
  type WorkflowBudgetPeriod,
  type JsonObject,
  workflowBudgetExhausted,
  Conflict,
} from '@otheater/core';
import type { DaemonEventPayloads } from '@otheater/protocol';
import { DURATION_PATTERN, durationMs } from '@otheater/workflows';
import { type SituationErrorLog, writeSituation } from '../situations.js';
import type { WorkflowsSettings } from './config.js';
import type { WorkflowLibrary } from './library.js';

/**
 * The bindings of the scenarios to workflows (docs/24 section 7, N296; plan of Phase 11b, P5). A
 * binding says "this scenario runs this workflow": which versions, with which inputs fixed, from
 * which triggers (P6), until when, with how much budget per period, and how many runs at once.
 * The state machine and its checks live in the store (`store.workflowBindings`); this class adds
 * what needs the clock, the configuration, the library and the event log:
 *
 * - the defaults of `workflows.binding.*` and `workflows.budget.period` for what a binding leaves
 *   out, and the check that the workflow is saved in the library and allowed;
 * - the deadline `until` as a date (epoch ms), a duration (`7d`) or `none`, and the expiry of the
 *   bindings whose deadline passed ({@link WorkflowBindings.tick});
 * - what an exhausted budget does (`workflows.budget.on_exhausted`: pause or stop), with the
 *   `workflow.budget_exhausted` event and a warning for the chat;
 * - an event `workflow.binding.changed` for every creation and every change of state.
 *
 * Every rule below that is not in docs/24 is [proposta].
 */

/** How a deadline is written: epoch ms, a duration from now (`30m`, `7d`), or none. */
export type BindingDeadline = number | string | null;

export interface BindingRequest {
  readonly scenarioId: string;
  readonly workflowId: string;
  readonly versionRange?: string | undefined;
  readonly params?: JsonObject | undefined;
  readonly triggers?: readonly JsonObject[] | undefined;
  /** `until`: epoch ms, a duration from now (`7d`), `'none'` or `null` for no deadline. */
  readonly until?: BindingDeadline | undefined;
  readonly budgetUsd?: number | null | undefined;
  readonly budgetPeriod?: WorkflowBudgetPeriod | undefined;
  readonly concurrency?: number | undefined;
  readonly onBusy?: WorkflowOnBusy | undefined;
}

/** What may change on a live binding; the same fields, without the scenario and the workflow. */
export type BindingChanges = Omit<BindingRequest, 'scenarioId' | 'workflowId'>;

/** What the chat shows the Producer when a budget runs out. */
export interface BudgetWarning {
  readonly binding: WorkflowBindingRecord;
  readonly action: 'pause' | 'stop';
  /** Ready to show: says which binding, how much was spent and what happened to it. */
  readonly text: string;
}

export interface WorkflowBindingsDeps {
  readonly store: Pick<Store, 'workflowBindings'> & { readonly events: Pick<EventLog, 'append'> };
  readonly library: Pick<WorkflowLibrary, 'resolve' | 'assertAllowed'>;
  readonly clock: Pick<Clock, 'now'>;
  readonly settings: () => WorkflowsSettings;
  readonly logger: SituationErrorLog;
  /** Told when a budget runs out (the channel shows it to the Producer in the chat). */
  readonly onBudgetExhausted?: ((warning: BudgetWarning) => void) | undefined;
}

/** The deadline as the store takes it: epoch ms, or null for none. */
export function parseDeadline(until: BindingDeadline, now: number): number | null {
  if (until === null || until === 'none') return null;
  if (typeof until === 'number') {
    if (!Number.isSafeInteger(until) || until < 0) {
      throw new InvalidInput(`until must be a date in epoch ms, got ${String(until)}`);
    }
    return until;
  }
  if (DURATION_PATTERN.test(until)) return now + durationMs(until);
  throw new InvalidInput(`until must be a date, a duration such as 7d, or none; got "${until}"`);
}

function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

export class WorkflowBindings {
  readonly #deps: WorkflowBindingsDeps;

  constructor(deps: WorkflowBindingsDeps) {
    this.#deps = deps;
  }

  /**
   * Binds a scenario to a workflow. The workflow must be allowed (`workflows.allowed`) and the
   * library must hold a version the range reaches (`NotFound` otherwise). What the request leaves
   * out takes the value of the configuration.
   */
  async create(request: BindingRequest): Promise<WorkflowBindingRecord> {
    this.#deps.library.assertAllowed(request.workflowId);
    const range = request.versionRange ?? '*';
    if ((await this.#deps.library.resolve(request.workflowId, range)) === undefined) {
      throw new NotFound(
        `the library has no version of ${request.workflowId} that matches "${range}"`,
      );
    }
    const settings = this.#deps.settings();
    const now = this.#deps.clock.now();
    const record = await this.#deps.store.workflowBindings.create(
      stripUndefined({
        scenarioId: request.scenarioId,
        workflowId: request.workflowId,
        versionRange: range,
        params: request.params,
        triggers: request.triggers === undefined ? undefined : [...request.triggers],
        until: request.until === undefined ? undefined : parseDeadline(request.until, now),
        budgetUsd: request.budgetUsd,
        budgetPeriod: request.budgetPeriod ?? settings.budget.period,
        concurrency: request.concurrency ?? settings.binding.concurrency,
        onBusy: request.onBusy ?? settings.binding.on_busy,
      }),
    );
    await this.#announce(record, null);
    return record;
  }

  get(id: string): Promise<WorkflowBindingRecord | undefined> {
    return this.#deps.store.workflowBindings.get(id);
  }

  list(filter?: WorkflowBindingListFilter): Promise<readonly WorkflowBindingRecord[]> {
    return this.#deps.store.workflowBindings.list(filter);
  }

  /** The bindings of a scenario that fire their triggers now. */
  active(scenarioId: string): Promise<readonly WorkflowBindingRecord[]> {
    return this.#deps.store.workflowBindings.list({ scenarioId, states: ['active'] });
  }

  /** Changes a live binding (not its state, and not its scenario or workflow). */
  update(id: string, changes: BindingChanges): Promise<WorkflowBindingRecord> {
    const now = this.#deps.clock.now();
    const patch = stripUndefined({
      versionRange: changes.versionRange,
      params: changes.params,
      triggers: changes.triggers === undefined ? undefined : [...changes.triggers],
      until: changes.until === undefined ? undefined : parseDeadline(changes.until, now),
      budgetUsd: changes.budgetUsd,
      budgetPeriod: changes.budgetPeriod,
      concurrency: changes.concurrency,
      onBusy: changes.onBusy,
    }) satisfies WorkflowBindingPatch;
    return this.#deps.store.workflowBindings.update(id, patch);
  }

  /** The Producer pauses the binding: its triggers stop firing until it is resumed. */
  pause(id: string): Promise<WorkflowBindingRecord> {
    return this.#move(id, 'paused', 'producer');
  }

  /** The Producer resumes a paused binding (`Conflict` past its deadline or with no budget left). */
  resume(id: string): Promise<WorkflowBindingRecord> {
    return this.#move(id, 'active', undefined);
  }

  /** The Producer ends the binding for good. */
  stop(id: string): Promise<WorkflowBindingRecord> {
    return this.#move(id, 'stopped', 'producer');
  }

  /**
   * Adds the cost of a run of this binding to the budget of the period. When that uses the budget
   * up and the binding is still `active`, it does what `workflows.budget.on_exhausted` says
   * (`pause`, the default, or `stop`) with the reason `budget`, records `workflow.budget_exhausted`
   * and tells the chat. Money spent is recorded in any state.
   */
  async recordSpend(id: string, usd: number): Promise<WorkflowBindingRecord> {
    const registry = this.#deps.store.workflowBindings;
    let record = await registry.recordSpend(id, usd);
    if (record.state !== 'active' || !workflowBudgetExhausted(record)) return record;
    const action = this.#deps.settings().budget.on_exhausted;
    const target: WorkflowBindingState = action === 'stop' ? 'stopped' : 'paused';
    try {
      record = await registry.transition(id, { to: target, reason: 'budget' });
    } catch (error) {
      // The Producer moved it first (paused, stopped or expired it): nothing left to do.
      if (error instanceof Conflict) return registry.get(id).then((now) => now ?? record);
      throw error;
    }
    const exhausted: DaemonEventPayloads['workflow.budget_exhausted'] = {
      bindingId: record.id,
      scenarioId: record.scenarioId,
      workflowId: record.workflowId,
      budgetUsd: record.budgetUsd ?? 0,
      spentUsd: record.spentUsd,
      period: record.budgetPeriod,
      periodStartedAt: record.periodStartedAt,
      action,
    };
    await writeSituation(
      this.#deps.store.events,
      this.#deps.logger,
      'workflow.budget_exhausted',
      exhausted,
      { scenarioId: record.scenarioId },
    );
    await this.#announce(record, 'active');
    this.#deps.onBudgetExhausted?.({
      binding: record,
      action,
      text:
        `The budget of the binding ${record.id} (${record.workflowId}) ran out: ` +
        `${record.spentUsd.toFixed(2)} of ${exhausted.budgetUsd.toFixed(2)} USD this ${record.budgetPeriod}. ` +
        (action === 'stop'
          ? 'The binding was stopped.'
          : 'The binding is paused until the next period; the Producer may resume it.'),
    });
    return record;
  }

  /**
   * One pass of upkeep, for a timer of the daemon (the interval is not this class's business):
   * 1. a binding whose deadline passed becomes `expired` (reason `deadline`);
   * 2. a binding paused for its budget goes back to `active` once a new period freed the budget.
   * Each change records `workflow.binding.changed`. Returns the bindings that changed.
   */
  async tick(): Promise<readonly WorkflowBindingRecord[]> {
    const registry = this.#deps.store.workflowBindings;
    const now = this.#deps.clock.now();
    const changed: WorkflowBindingRecord[] = [];
    const live = await registry.list({ states: ['active', 'paused'] });
    for (const binding of live) {
      if (binding.until !== null && binding.until <= now) {
        const moved = await this.#tryMove(binding, 'expired', 'deadline');
        if (moved !== undefined) changed.push(moved);
        continue;
      }
      if (binding.state === 'paused' && binding.stateReason === 'budget') {
        const rolled = await registry.rollPeriod(binding.id);
        if (!workflowBudgetExhausted(rolled)) {
          const moved = await this.#tryMove(rolled, 'active', undefined);
          if (moved !== undefined) changed.push(moved);
        }
      }
    }
    return changed;
  }

  async #move(
    id: string,
    to: WorkflowBindingState,
    reason: WorkflowBindingReason | undefined,
  ): Promise<WorkflowBindingRecord> {
    const registry = this.#deps.store.workflowBindings;
    const before = await registry.get(id);
    if (before === undefined) throw new NotFound(`there is no binding ${id}`);
    const record = await registry.transition(id, reason === undefined ? { to } : { to, reason });
    await this.#announce(record, before.state);
    return record;
  }

  /** A move the clock decided; losing a race to the Producer is not an error. */
  async #tryMove(
    before: WorkflowBindingRecord,
    to: WorkflowBindingState,
    reason: WorkflowBindingReason | undefined,
  ): Promise<WorkflowBindingRecord | undefined> {
    try {
      const record = await this.#deps.store.workflowBindings.transition(
        before.id,
        reason === undefined ? { to } : { to, reason },
      );
      await this.#announce(record, before.state);
      return record;
    } catch (error) {
      if (error instanceof Conflict) return undefined;
      throw error;
    }
  }

  #announce(record: WorkflowBindingRecord, from: WorkflowBindingState | null): Promise<void> {
    return writeSituation(
      this.#deps.store.events,
      this.#deps.logger,
      'workflow.binding.changed',
      {
        bindingId: record.id,
        scenarioId: record.scenarioId,
        workflowId: record.workflowId,
        from,
        to: record.state,
        reason: record.stateReason,
      },
      { scenarioId: record.scenarioId },
    );
  }
}
