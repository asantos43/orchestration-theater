// SPDX-License-Identifier: MPL-2.0
import { Conflict } from '../errors.js';
import type { Clock } from '../ports/clock.js';
import {
  DecisionAnswerSchema,
  DecisionRecordSchema,
  DemandPatchSchema,
  DemandRecordSchema,
  NewDecisionSchema,
  NewDemandSchema,
  NewPlaySchema,
  NewStageSchema,
  PlayPatchSchema,
  PlayRecordSchema,
  StagePatchSchema,
  StageRecordSchema,
  type DecisionAnswer,
  type DecisionListFilter,
  type DecisionRecord,
  type DecisionRegistry,
  type DemandListFilter,
  type DemandPatch,
  type DemandRecord,
  type DemandRegistry,
  type NewDecision,
  type NewDemand,
  type NewPlay,
  type NewStage,
  type PlayListFilter,
  type PlayPatch,
  type PlayRecord,
  type PlayRegistry,
  type StageListFilter,
  type StagePatch,
  type StageRecord,
  type StageRegistry,
} from '../ports/plays.js';
import type { RecordTable, TableSpec } from './record-table.js';
import { applyPatch, eqTerms, inTerm, mustExist, parseOrThrow } from './support.js';

export const PLAYS_SPEC: TableSpec<PlayRecord> = {
  name: 'plays',
  schema: PlayRecordSchema,
  key: ['id'],
  json: ['snapshot', 'counters'],
};

export const STAGES_SPEC: TableSpec<StageRecord> = {
  name: 'stages',
  schema: StageRecordSchema,
  key: ['id'],
  json: ['result'],
};

export const DEMANDS_SPEC: TableSpec<DemandRecord> = {
  name: 'demands',
  schema: DemandRecordSchema,
  key: ['playId', 'id'],
  json: ['dependsOn', 'contract', 'expectedFiles', 'acceptanceCriteria', 'verify'],
};

export const DECISIONS_SPEC: TableSpec<DecisionRecord> = {
  name: 'decisions',
  schema: DecisionRecordSchema,
  key: ['id'],
  json: ['input', 'answer'],
};

type Time = Pick<Clock, 'now'>;

/** `PlayRegistry` over a {@link RecordTable}. */
export class TablePlayRegistry implements PlayRegistry {
  constructor(
    private readonly table: RecordTable<PlayRecord>,
    private readonly clock: Time,
  ) {}

  async create(input: NewPlay): Promise<PlayRecord> {
    const given = parseOrThrow(NewPlaySchema, input, 'play');
    const now = this.clock.now();
    const record: PlayRecord = {
      id: given.id,
      scenarioId: given.scenarioId,
      need: given.need,
      flowId: given.flowId,
      flowVersion: given.flowVersion,
      state: given.state,
      snapshot: given.snapshot ?? null,
      counters: given.counters ?? {},
      parentPlayId: given.parentPlayId ?? null,
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
    };
    await this.table.insert(record);
    return record;
  }

  get(id: string): Promise<PlayRecord | undefined> {
    return this.table.get({ id });
  }

  async list(filter: PlayListFilter = {}): Promise<readonly PlayRecord[]> {
    const rows = await this.table.select({
      eq: eqTerms({ scenarioId: filter.scenarioId }),
      in: inTerm('state', filter.states),
      orderBy: [{ field: 'createdAt' }, { field: 'id' }],
    });
    const open = filter.open;
    return open === undefined ? rows : rows.filter((play) => (play.finishedAt === null) === open);
  }

  async update(id: string, patch: PlayPatch): Promise<PlayRecord> {
    const changes = parseOrThrow(PlayPatchSchema, patch, 'play patch');
    const current = mustExist(await this.table.get({ id }), 'Play', id);
    const next: PlayRecord = { ...applyPatch(current, changes), updatedAt: this.clock.now() };
    await this.table.replace(next);
    return next;
  }
}

/** `StageRegistry` over a {@link RecordTable}. */
export class TableStageRegistry implements StageRegistry {
  constructor(
    private readonly table: RecordTable<StageRecord>,
    private readonly clock: Time,
  ) {}

  async create(input: NewStage): Promise<StageRecord> {
    const given = parseOrThrow(NewStageSchema, input, 'stage');
    const now = this.clock.now();
    const state = given.state ?? 'running';
    const record: StageRecord = {
      id: given.id,
      playId: given.playId,
      name: given.name,
      role: given.role,
      attemptId: given.attemptId ?? null,
      demandId: given.demandId ?? null,
      state,
      result: given.result ?? null,
      createdAt: now,
      updatedAt: now,
      endedAt: state === 'running' ? null : now,
    };
    await this.table.insert(record);
    return record;
  }

  get(id: string): Promise<StageRecord | undefined> {
    return this.table.get({ id });
  }

  list(filter: StageListFilter = {}): Promise<readonly StageRecord[]> {
    return this.table.select({
      eq: eqTerms({ playId: filter.playId }),
      in: inTerm('state', filter.states),
      orderBy: [{ field: 'createdAt' }, { field: 'id' }],
    });
  }

  async update(id: string, patch: StagePatch): Promise<StageRecord> {
    const changes = parseOrThrow(StagePatchSchema, patch, 'stage patch');
    const current = mustExist(await this.table.get({ id }), 'Stage', id);
    const now = this.clock.now();
    const merged = applyPatch(current, changes);
    // A stage that leaves `running` ends now, unless the caller says when it ended.
    const ended = merged.state !== 'running' && merged.endedAt === null;
    const next: StageRecord = { ...merged, updatedAt: now, endedAt: ended ? now : merged.endedAt };
    await this.table.replace(next);
    return next;
  }
}

/** `DemandRegistry` over a {@link RecordTable}. */
export class TableDemandRegistry implements DemandRegistry {
  constructor(
    private readonly table: RecordTable<DemandRecord>,
    private readonly clock: Time,
  ) {}

  async create(input: NewDemand): Promise<DemandRecord> {
    const given = parseOrThrow(NewDemandSchema, input, 'demand');
    const now = this.clock.now();
    const record: DemandRecord = {
      playId: given.playId,
      id: given.id,
      title: given.title,
      description: given.description,
      dependsOn: given.dependsOn,
      contract: given.contract,
      expectedFiles: given.expectedFiles,
      complexity: given.complexity,
      specialty: given.specialty ?? null,
      timeoutMin: given.timeoutMin,
      acceptanceCriteria: given.acceptanceCriteria,
      verify: given.verify,
      verifyWaiver: given.verifyWaiver ?? null,
      state: given.state ?? 'pending',
      createdAt: now,
      updatedAt: now,
    };
    await this.table.insert(record);
    return record;
  }

  get(playId: string, id: string): Promise<DemandRecord | undefined> {
    return this.table.get({ playId, id });
  }

  list(filter: DemandListFilter = {}): Promise<readonly DemandRecord[]> {
    return this.table.select({
      eq: eqTerms({ playId: filter.playId }),
      in: inTerm('state', filter.states),
      orderBy: [{ field: 'createdAt' }, { field: 'playId' }, { field: 'id' }],
    });
  }

  async update(playId: string, id: string, patch: DemandPatch): Promise<DemandRecord> {
    const changes = parseOrThrow(DemandPatchSchema, patch, 'demand patch');
    const current = mustExist(await this.table.get({ playId, id }), 'Demand', `${playId}/${id}`);
    const next: DemandRecord = { ...applyPatch(current, changes), updatedAt: this.clock.now() };
    await this.table.replace(next);
    return next;
  }
}

/** `DecisionRegistry` over a {@link RecordTable}. */
export class TableDecisionRegistry implements DecisionRegistry {
  constructor(
    private readonly table: RecordTable<DecisionRecord>,
    private readonly clock: Time,
  ) {}

  async create(input: NewDecision): Promise<DecisionRecord> {
    const given = parseOrThrow(NewDecisionSchema, input, 'decision');
    const now = this.clock.now();
    const record: DecisionRecord = {
      id: given.id,
      scenarioId: given.scenarioId,
      playId: given.playId ?? null,
      kind: given.kind,
      input: given.input,
      answer: null,
      decidedBy: null,
      state: 'pending',
      createdAt: now,
      updatedAt: now,
      decidedAt: null,
    };
    await this.table.insert(record);
    return record;
  }

  get(id: string): Promise<DecisionRecord | undefined> {
    return this.table.get({ id });
  }

  list(filter: DecisionListFilter = {}): Promise<readonly DecisionRecord[]> {
    return this.table.select({
      eq: eqTerms({ scenarioId: filter.scenarioId, playId: filter.playId }),
      in: { ...inTerm('kind', filter.kinds), ...inTerm('state', filter.states) },
      orderBy: [{ field: 'createdAt' }, { field: 'id' }],
    });
  }

  async decide(id: string, answer: DecisionAnswer): Promise<DecisionRecord> {
    const given = parseOrThrow(DecisionAnswerSchema, answer, 'decision answer');
    const current = await this.#pending(id);
    const now = this.clock.now();
    const next: DecisionRecord = {
      ...current,
      answer: given.answer,
      decidedBy: given.decidedBy,
      state: 'decided',
      updatedAt: now,
      decidedAt: now,
    };
    await this.table.replace(next);
    return next;
  }

  async cancel(id: string): Promise<DecisionRecord> {
    const current = await this.#pending(id);
    const next: DecisionRecord = { ...current, state: 'cancelled', updatedAt: this.clock.now() };
    await this.table.replace(next);
    return next;
  }

  async #pending(id: string): Promise<DecisionRecord> {
    const current = mustExist(await this.table.get({ id }), 'Decision', id);
    if (current.state !== 'pending') {
      throw new Conflict(`Decision ${id} is ${current.state}, not pending`);
    }
    return current;
  }
}
