// SPDX-License-Identifier: MPL-2.0
import { Conflict, InvalidInput } from '../errors.js';
import type { Clock } from '../ports/clock.js';
import {
  NewSetupRunSchema,
  SetupRunPatchSchema,
  SetupRunRecordSchema,
  type NewSetupRun,
  type SetupRunListFilter,
  type SetupRunPatch,
  type SetupRunRecord,
  type SetupRunRegistry,
} from '../ports/setup-runs.js';
import type { RecordTable, TableSpec } from './record-table.js';
import { nextSeq } from './sequence.js';
import { applyPatch, eqTerms, inTerm, mustExist, parseOrThrow } from './support.js';

export const SETUP_RUNS_SPEC: TableSpec<SetupRunRecord> = {
  name: 'setup_runs',
  schema: SetupRunRecordSchema,
  key: ['id'],
  json: ['done', 'result'],
};

/** `SetupRunRegistry` over a {@link RecordTable}. */
export class TableSetupRunRegistry implements SetupRunRegistry {
  constructor(
    private readonly table: RecordTable<SetupRunRecord>,
    private readonly clock: Pick<Clock, 'now'>,
  ) {}

  async create(input: NewSetupRun): Promise<SetupRunRecord> {
    const given = parseOrThrow(NewSetupRunSchema, input, 'setup run');
    const [existing] = await this.table.select({
      eq: { flow: given.flow, state: 'active' },
      orderBy: [{ field: 'seq' }],
      limit: 1,
    });
    if (existing !== undefined) {
      throw new Conflict(`The setup flow ${given.flow} already has the active run ${existing.id}`);
    }
    const now = this.clock.now();
    const seq = await nextSeq(this.table);
    const record: SetupRunRecord = {
      id: `SR${String(seq)}`,
      seq,
      flow: given.flow,
      state: 'active',
      step: given.step,
      done: [],
      result: null,
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
    };
    await this.table.insert(record);
    return record;
  }

  get(id: string): Promise<SetupRunRecord | undefined> {
    return this.table.get({ id });
  }

  list(filter: SetupRunListFilter = {}): Promise<readonly SetupRunRecord[]> {
    return this.table.select({
      eq: eqTerms({ flow: filter.flow }),
      in: inTerm('state', filter.states),
      orderBy: [{ field: 'seq' }],
    });
  }

  async update(id: string, patch: SetupRunPatch): Promise<SetupRunRecord> {
    const given = parseOrThrow(SetupRunPatchSchema, patch, 'setup run patch');
    if (given.result !== undefined && given.state !== 'confirmed') {
      throw new InvalidInput('Invalid setup run patch: result only goes with state confirmed');
    }
    const current = mustExist(await this.table.get({ id }), 'Setup run', id);
    if (current.state !== 'active') {
      throw new Conflict(`Setup run ${id} is already ${current.state}`);
    }
    const now = this.clock.now();
    const next: SetupRunRecord = {
      ...applyPatch(current, given),
      updatedAt: now,
      finishedAt: given.state === undefined ? null : now,
    };
    await this.table.replace(next);
    return next;
  }
}
