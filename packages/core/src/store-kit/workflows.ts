// SPDX-License-Identifier: MPL-2.0
import { Conflict, InvalidInput } from '../errors.js';
import type { Clock } from '../ports/clock.js';
import {
  NewWorkflowBindingSchema,
  NewWorkflowDefinitionSchema,
  WORKFLOW_BUDGET_PERIOD_MS,
  WorkflowBindingPatchSchema,
  WorkflowBindingRecordSchema,
  WorkflowBindingTransitionSchema,
  WorkflowDefinitionRecordSchema,
  workflowBudgetExhausted,
  type NewWorkflowBinding,
  type NewWorkflowDefinition,
  type WorkflowBindingListFilter,
  type WorkflowBindingPatch,
  type WorkflowBindingReason,
  type WorkflowBindingRecord,
  type WorkflowBindingRegistry,
  type WorkflowBindingState,
  type WorkflowBindingTransition,
  type WorkflowDefinitionListFilter,
  type WorkflowDefinitionRecord,
  type WorkflowDefinitionRegistry,
} from '../ports/workflows.js';
import type { RecordTable, TableSpec } from './record-table.js';
import { nextSeq } from './sequence.js';
import { applyPatch, eqTerms, inTerm, mustExist, parseOrThrow } from './support.js';

export const WORKFLOW_DEFINITIONS_SPEC: TableSpec<WorkflowDefinitionRecord> = {
  name: 'workflow_definitions',
  schema: WorkflowDefinitionRecordSchema,
  key: ['workflowId', 'version'],
  json: ['definition'],
};

export const WORKFLOW_BINDINGS_SPEC: TableSpec<WorkflowBindingRecord> = {
  name: 'workflow_bindings',
  schema: WorkflowBindingRecordSchema,
  key: ['id'],
  json: ['params', 'triggers'],
};

/** `WorkflowDefinitionRegistry` over a {@link RecordTable}. */
export class TableWorkflowDefinitionRegistry implements WorkflowDefinitionRegistry {
  constructor(
    private readonly table: RecordTable<WorkflowDefinitionRecord>,
    private readonly clock: Pick<Clock, 'now'>,
  ) {}

  async put(input: NewWorkflowDefinition): Promise<WorkflowDefinitionRecord> {
    const given = parseOrThrow(NewWorkflowDefinitionSchema, input, 'workflow definition');
    const existing = await this.table.get({ workflowId: given.workflowId, version: given.version });
    if (existing !== undefined) {
      if (existing.hash === given.hash) return existing;
      throw new Conflict(
        `The workflow ${given.workflowId} version ${given.version} already exists with another content`,
      );
    }
    const now = this.clock.now();
    const record: WorkflowDefinitionRecord = {
      workflowId: given.workflowId,
      version: given.version,
      seq: await nextSeq(this.table),
      hash: given.hash,
      definition: given.definition,
      source: given.source,
      packageId: given.packageId ?? null,
      state: 'inactive',
      createdAt: now,
      updatedAt: now,
      activatedAt: null,
    };
    await this.table.insert(record);
    return record;
  }

  get(workflowId: string, version: string): Promise<WorkflowDefinitionRecord | undefined> {
    return this.table.get({ workflowId, version });
  }

  async active(workflowId: string): Promise<WorkflowDefinitionRecord | undefined> {
    const [found] = await this.table.select({
      eq: { workflowId, state: 'active' },
      orderBy: [{ field: 'seq' }],
      limit: 1,
    });
    return found;
  }

  list(filter: WorkflowDefinitionListFilter = {}): Promise<readonly WorkflowDefinitionRecord[]> {
    return this.table.select({
      eq: eqTerms({ workflowId: filter.workflowId, source: filter.source }),
      in: inTerm('state', filter.states),
      orderBy: [{ field: 'workflowId' }, { field: 'seq' }],
    });
  }

  async activate(workflowId: string, version: string): Promise<WorkflowDefinitionRecord> {
    const target = mustExist(
      await this.table.get({ workflowId, version }),
      'Workflow definition',
      `${workflowId}@${version}`,
    );
    if (target.state === 'active') return target;
    const now = this.clock.now();
    const previous = await this.active(workflowId);
    // The old active version goes first: a backend may hold one active version per workflow.
    if (previous !== undefined) {
      await this.table.replace({ ...previous, state: 'inactive', updatedAt: now });
    }
    const next: WorkflowDefinitionRecord = {
      ...target,
      state: 'active',
      updatedAt: now,
      activatedAt: now,
    };
    await this.table.replace(next);
    return next;
  }

  async remove(workflowId: string, version: string): Promise<void> {
    const found = mustExist(
      await this.table.get({ workflowId, version }),
      'Workflow definition',
      `${workflowId}@${version}`,
    );
    if (found.state === 'active') {
      throw new Conflict(`The workflow ${workflowId} version ${version} is the active one`);
    }
    await this.table.delete({ workflowId, version });
  }
}

/**
 * The period of a binding as of `now`: when the current one is over, the start moves forward by
 * whole periods (so it stays on the grid of the first one) and the spent amount goes back to
 * zero. Otherwise the record itself.
 */
export function rolledBindingPeriod(
  record: WorkflowBindingRecord,
  now: number,
): WorkflowBindingRecord {
  const length = WORKFLOW_BUDGET_PERIOD_MS[record.budgetPeriod];
  const elapsed = now - record.periodStartedAt;
  if (elapsed < length) return record;
  const periods = Math.floor(elapsed / length);
  return {
    ...record,
    periodStartedAt: record.periodStartedAt + periods * length,
    spentUsd: 0,
    updatedAt: now,
  };
}

const LIVE_STATES: readonly WorkflowBindingState[] = ['active', 'paused'];

/** What each target state of `transition` takes as `reason`: the allowed ones and the default. */
const TRANSITION_REASONS: Readonly<
  Record<
    WorkflowBindingState,
    {
      readonly allowed: readonly WorkflowBindingReason[];
      readonly fallback: WorkflowBindingReason | null;
    }
  >
> = {
  active: { allowed: [], fallback: null },
  paused: { allowed: ['producer', 'budget'], fallback: null },
  stopped: { allowed: ['producer', 'budget'], fallback: null },
  expired: { allowed: ['deadline'], fallback: 'deadline' },
};

/** `WorkflowBindingRegistry` over a {@link RecordTable}. */
export class TableWorkflowBindingRegistry implements WorkflowBindingRegistry {
  constructor(
    private readonly table: RecordTable<WorkflowBindingRecord>,
    private readonly clock: Pick<Clock, 'now'>,
  ) {}

  async create(input: NewWorkflowBinding): Promise<WorkflowBindingRecord> {
    const given = parseOrThrow(NewWorkflowBindingSchema, input, 'workflow binding');
    const now = this.clock.now();
    this.#mustBeInTheFuture(given.until, now);
    const [clash] = await this.table.select({
      eq: { scenarioId: given.scenarioId, workflowId: given.workflowId },
      in: { state: LIVE_STATES },
      orderBy: [{ field: 'seq' }],
      limit: 1,
    });
    if (clash !== undefined) {
      throw new Conflict(
        `The scenario ${given.scenarioId} already has the binding ${clash.id} to the workflow ${given.workflowId}`,
      );
    }
    const seq = await nextSeq(this.table);
    const record: WorkflowBindingRecord = {
      id: `WB${String(seq)}`,
      seq,
      scenarioId: given.scenarioId,
      workflowId: given.workflowId,
      versionRange: given.versionRange ?? '*',
      params: given.params ?? {},
      triggers: given.triggers ?? [],
      state: 'active',
      stateReason: null,
      until: given.until ?? null,
      budgetUsd: given.budgetUsd ?? null,
      budgetPeriod: given.budgetPeriod ?? 'day',
      spentUsd: 0,
      periodStartedAt: now,
      concurrency: given.concurrency ?? 1,
      onBusy: given.onBusy ?? 'queue',
      createdAt: now,
      updatedAt: now,
      stateChangedAt: now,
    };
    await this.table.insert(record);
    return record;
  }

  get(id: string): Promise<WorkflowBindingRecord | undefined> {
    return this.table.get({ id });
  }

  list(filter: WorkflowBindingListFilter = {}): Promise<readonly WorkflowBindingRecord[]> {
    return this.table.select({
      eq: eqTerms({ scenarioId: filter.scenarioId, workflowId: filter.workflowId }),
      in: inTerm('state', filter.states),
      orderBy: [{ field: 'seq' }],
    });
  }

  async update(id: string, patch: WorkflowBindingPatch): Promise<WorkflowBindingRecord> {
    const given = parseOrThrow(WorkflowBindingPatchSchema, patch, 'workflow binding patch');
    const current = mustExist(await this.table.get({ id }), 'Workflow binding', id);
    if (!LIVE_STATES.includes(current.state)) {
      throw new Conflict(`Workflow binding ${id} is already ${current.state}`);
    }
    const now = this.clock.now();
    this.#mustBeInTheFuture(given.until, now);
    const next: WorkflowBindingRecord = {
      ...applyPatch(current, given as Partial<WorkflowBindingRecord>),
      updatedAt: now,
    };
    await this.table.replace(next);
    return next;
  }

  async transition(id: string, move: WorkflowBindingTransition): Promise<WorkflowBindingRecord> {
    const given = parseOrThrow(
      WorkflowBindingTransitionSchema,
      move,
      'workflow binding transition',
    );
    const rule = TRANSITION_REASONS[given.to];
    const reason = given.reason ?? rule.fallback;
    if (given.to === 'active' ? given.reason !== undefined : reason === null) {
      throw new InvalidInput(
        given.to === 'active'
          ? 'Invalid workflow binding transition: resuming takes no reason'
          : `Invalid workflow binding transition: ${given.to} needs a reason`,
      );
    }
    if (reason !== null && !rule.allowed.includes(reason)) {
      throw new InvalidInput(
        `Invalid workflow binding transition: the reason ${reason} does not go with ${given.to}`,
      );
    }
    const stored = mustExist(await this.table.get({ id }), 'Workflow binding', id);
    const now = this.clock.now();
    const current = rolledBindingPeriod(stored, now);
    const allowedFrom: readonly WorkflowBindingState[] =
      given.to === 'active' ? ['paused'] : given.to === 'paused' ? ['active'] : LIVE_STATES;
    if (!allowedFrom.includes(current.state)) {
      throw new Conflict(`Workflow binding ${id} cannot go from ${current.state} to ${given.to}`);
    }
    const deadlinePassed = current.until !== null && now >= current.until;
    if (given.to === 'expired' && !deadlinePassed) {
      throw new Conflict(`Workflow binding ${id} has not reached its deadline`);
    }
    if (given.to === 'active') {
      if (deadlinePassed) {
        throw new Conflict(`Workflow binding ${id} cannot resume: its deadline has passed`);
      }
      if (workflowBudgetExhausted(current)) {
        throw new Conflict(
          `Workflow binding ${id} cannot resume: the budget of the period is used up`,
        );
      }
    }
    const next: WorkflowBindingRecord = {
      ...current,
      state: given.to,
      stateReason: reason,
      updatedAt: now,
      stateChangedAt: now,
    };
    await this.table.replace(next);
    return next;
  }

  async recordSpend(id: string, usd: number): Promise<WorkflowBindingRecord> {
    if (!Number.isFinite(usd) || usd < 0) {
      throw new InvalidInput(
        'Invalid workflow binding spend: usd must be a number of zero or more',
      );
    }
    const stored = mustExist(await this.table.get({ id }), 'Workflow binding', id);
    const now = this.clock.now();
    const current = rolledBindingPeriod(stored, now);
    const next: WorkflowBindingRecord = {
      ...current,
      spentUsd: current.spentUsd + usd,
      updatedAt: now,
    };
    await this.table.replace(next);
    return next;
  }

  async rollPeriod(id: string): Promise<WorkflowBindingRecord> {
    const stored = mustExist(await this.table.get({ id }), 'Workflow binding', id);
    const rolled = rolledBindingPeriod(stored, this.clock.now());
    if (rolled === stored) return stored;
    await this.table.replace(rolled);
    return rolled;
  }

  #mustBeInTheFuture(until: number | null | undefined, now: number): void {
    if (until !== undefined && until !== null && until <= now) {
      throw new InvalidInput('Invalid workflow binding: until must be in the future');
    }
  }
}
