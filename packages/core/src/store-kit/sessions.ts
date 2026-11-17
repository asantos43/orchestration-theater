// SPDX-License-Identifier: MPL-2.0
import type { Clock } from '../ports/clock.js';
import {
  NewSessionSchema,
  SessionPatchSchema,
  SessionRecordSchema,
  type NewSession,
  type SessionListFilter,
  type SessionPatch,
  type SessionRecord,
  type SessionRegistry,
} from '../ports/sessions.js';
import type { RecordTable, TableSpec } from './record-table.js';
import { applyPatch, eqTerms, inTerm, mustExist, parseOrThrow } from './support.js';

export const SESSIONS_SPEC: TableSpec<SessionRecord> = {
  name: 'sessions',
  schema: SessionRecordSchema,
  key: ['id'],
  json: [],
};

/** `SessionRegistry` over a {@link RecordTable}. */
export class TableSessionRegistry implements SessionRegistry {
  constructor(
    private readonly table: RecordTable<SessionRecord>,
    private readonly clock: Pick<Clock, 'now'>,
  ) {}

  async open(input: NewSession): Promise<SessionRecord> {
    const given = parseOrThrow(NewSessionSchema, input, 'session');
    const now = this.clock.now();
    const state = given.state ?? 'active';
    const record: SessionRecord = {
      id: given.id,
      client: given.client,
      profile: given.profile,
      role: given.role ?? null,
      attemptId: given.attemptId ?? null,
      worktree: given.worktree ?? null,
      clientSessionId: given.clientSessionId ?? null,
      pid: given.pid ?? null,
      processStartedAt: given.processStartedAt ?? null,
      state,
      createdAt: now,
      updatedAt: now,
      endedAt: state === 'closed' ? now : null,
    };
    await this.table.insert(record);
    return record;
  }

  get(id: string): Promise<SessionRecord | undefined> {
    return this.table.get({ id });
  }

  list(filter: SessionListFilter = {}): Promise<readonly SessionRecord[]> {
    return this.table.select({
      eq: eqTerms({
        attemptId: filter.attemptId,
        client: filter.client,
        profile: filter.profile,
      }),
      in: inTerm('state', filter.states),
      orderBy: [{ field: 'createdAt' }, { field: 'id' }],
    });
  }

  async update(id: string, patch: SessionPatch): Promise<SessionRecord> {
    const changes = parseOrThrow(SessionPatchSchema, patch, 'session patch');
    const current = mustExist(await this.table.get({ id }), 'Session', id);
    const now = this.clock.now();
    const merged = applyPatch(current, changes);
    const closes = merged.state === 'closed' && merged.endedAt === null;
    const next: SessionRecord = {
      ...merged,
      updatedAt: now,
      endedAt: closes ? now : merged.endedAt,
    };
    await this.table.replace(next);
    return next;
  }
}
