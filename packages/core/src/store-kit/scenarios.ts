// SPDX-License-Identifier: MPL-2.0
import type { Clock } from '../ports/clock.js';
import {
  AttachmentRecordSchema,
  NewAttachmentSchema,
  NewScenarioRepoSchema,
  NewScenarioSchema,
  ScenarioPatchSchema,
  ScenarioRecordSchema,
  ScenarioRepoRecordSchema,
  type AttachmentRecord,
  type AttachmentRegistry,
  type NewAttachment,
  type NewScenario,
  type NewScenarioRepo,
  type ScenarioListFilter,
  type ScenarioPatch,
  type ScenarioRecord,
  type ScenarioRegistry,
  type ScenarioRepoRecord,
  type ScenarioRepoRegistry,
} from '../ports/scenarios.js';
import type { RecordTable, TableSpec } from './record-table.js';
import { applyPatch, inTerm, mustExist, parseOrThrow } from './support.js';

export const SCENARIOS_SPEC: TableSpec<ScenarioRecord> = {
  name: 'scenarios',
  schema: ScenarioRecordSchema,
  key: ['id'],
  json: ['conventions', 'configOverride'],
};

export const SCENARIO_REPOS_SPEC: TableSpec<ScenarioRepoRecord> = {
  name: 'scenario_repos',
  schema: ScenarioRepoRecordSchema,
  key: ['scenarioId', 'path'],
  json: [],
};

export const ATTACHMENTS_SPEC: TableSpec<AttachmentRecord> = {
  name: 'attachments',
  schema: AttachmentRecordSchema,
  key: ['scenarioId', 'id'],
  json: [],
};

type Time = Pick<Clock, 'now'>;

/** `ScenarioRegistry` over a {@link RecordTable}. */
export class TableScenarioRegistry implements ScenarioRegistry {
  constructor(
    private readonly table: RecordTable<ScenarioRecord>,
    private readonly clock: Time,
  ) {}

  async create(input: NewScenario): Promise<ScenarioRecord> {
    const given = parseOrThrow(NewScenarioSchema, input, 'scenario');
    const now = this.clock.now();
    const record: ScenarioRecord = {
      id: given.id,
      kind: given.kind,
      flowId: given.flowId,
      name: given.name,
      folder: given.folder,
      profile: given.profile ?? null,
      conventions: given.conventions ?? null,
      baseBranch: given.baseBranch ?? null,
      configOverride: given.configOverride ?? {},
      originScenarioId: given.originScenarioId ?? null,
      directorState: given.directorState ?? 'active',
      state: given.state ?? 'active',
      createdAt: now,
      updatedAt: now,
    };
    await this.table.insert(record);
    return record;
  }

  get(id: string): Promise<ScenarioRecord | undefined> {
    return this.table.get({ id });
  }

  list(filter: ScenarioListFilter = {}): Promise<readonly ScenarioRecord[]> {
    return this.table.select({
      in: { ...inTerm('kind', filter.kinds), ...inTerm('state', filter.states) },
      orderBy: [{ field: 'createdAt' }, { field: 'id' }],
    });
  }

  async update(id: string, patch: ScenarioPatch): Promise<ScenarioRecord> {
    const changes = parseOrThrow(ScenarioPatchSchema, patch, 'scenario patch');
    const current = mustExist(await this.table.get({ id }), 'Scenario', id);
    const next: ScenarioRecord = {
      ...applyPatch(current, changes),
      updatedAt: this.clock.now(),
    };
    await this.table.replace(next);
    return next;
  }
}

/** `ScenarioRepoRegistry` over a {@link RecordTable}. */
export class TableScenarioRepoRegistry implements ScenarioRepoRegistry {
  constructor(
    private readonly table: RecordTable<ScenarioRepoRecord>,
    private readonly clock: Time,
  ) {}

  async put(input: NewScenarioRepo): Promise<ScenarioRepoRecord> {
    const given = parseOrThrow(NewScenarioRepoSchema, input, 'scenario repository');
    const existing = await this.table.get({ scenarioId: given.scenarioId, path: given.path });
    const record: ScenarioRepoRecord = {
      scenarioId: given.scenarioId,
      path: given.path,
      remote: given.remote ?? null,
      mainBranch: given.mainBranch,
      createdAt: existing?.createdAt ?? this.clock.now(),
    };
    if (existing === undefined) await this.table.insert(record);
    else await this.table.replace(record);
    return record;
  }

  get(scenarioId: string, path: string): Promise<ScenarioRepoRecord | undefined> {
    return this.table.get({ scenarioId, path });
  }

  list(scenarioId: string): Promise<readonly ScenarioRepoRecord[]> {
    return this.table.select({
      eq: { scenarioId },
      orderBy: [{ field: 'createdAt' }, { field: 'path' }],
    });
  }

  remove(scenarioId: string, path: string): Promise<boolean> {
    return this.table.delete({ scenarioId, path });
  }
}

/** `AttachmentRegistry` over a {@link RecordTable}. */
export class TableAttachmentRegistry implements AttachmentRegistry {
  constructor(
    private readonly table: RecordTable<AttachmentRecord>,
    private readonly clock: Time,
  ) {}

  async add(input: NewAttachment): Promise<AttachmentRecord> {
    const given = parseOrThrow(NewAttachmentSchema, input, 'attachment');
    const [last] = await this.table.select({
      eq: { scenarioId: given.scenarioId },
      orderBy: [{ field: 'seq', desc: true }],
      limit: 1,
    });
    const seq = (last?.seq ?? 0) + 1;
    const record: AttachmentRecord = {
      scenarioId: given.scenarioId,
      id: `A${String(seq)}`,
      seq,
      messageId: given.messageId ?? null,
      name: given.name,
      mime: given.mime,
      size: given.size,
      hash: given.hash,
      source: given.source,
      path: given.path,
      createdAt: this.clock.now(),
    };
    await this.table.insert(record);
    return record;
  }

  get(scenarioId: string, id: string): Promise<AttachmentRecord | undefined> {
    return this.table.get({ scenarioId, id });
  }

  list(scenarioId: string): Promise<readonly AttachmentRecord[]> {
    return this.table.select({ eq: { scenarioId }, orderBy: [{ field: 'seq' }] });
  }
}
