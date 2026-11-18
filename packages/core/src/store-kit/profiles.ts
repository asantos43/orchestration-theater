// SPDX-License-Identifier: MPL-2.0
import { Conflict } from '../errors.js';
import type { Clock } from '../ports/clock.js';
import {
  NewProfileSchema,
  PROFILE_TRANSITIONS,
  ProfilePatchSchema,
  ProfileRecordSchema,
  type NewProfile,
  type ProfileListFilter,
  type ProfilePatch,
  type ProfileRecord,
  type ProfileRegistry,
} from '../ports/profiles.js';
import type { RecordTable, TableSpec } from './record-table.js';
import { applyPatch, eqTerms, inTerm, mustExist, parseOrThrow } from './support.js';

export const PROFILES_SPEC: TableSpec<ProfileRecord> = {
  name: 'profiles',
  schema: ProfileRecordSchema,
  key: ['id'],
  json: [],
};

/** `ProfileRegistry` over a {@link RecordTable}. */
export class TableProfileRegistry implements ProfileRegistry {
  constructor(
    private readonly table: RecordTable<ProfileRecord>,
    private readonly clock: Pick<Clock, 'now'>,
  ) {}

  async create(input: NewProfile): Promise<ProfileRecord> {
    const given = parseOrThrow(NewProfileSchema, input, 'profile');
    const now = this.clock.now();
    const record: ProfileRecord = {
      id: `${given.client}/${given.name}`,
      client: given.client,
      name: given.name,
      kind: given.kind,
      provider: given.provider,
      state: 'active',
      dir: given.dir,
      secretRef: given.secretRef ?? null,
      noticeAcceptedAt: null,
      createdAt: now,
      updatedAt: now,
      removedAt: null,
    };
    await this.table.insert(record);
    return record;
  }

  get(id: string): Promise<ProfileRecord | undefined> {
    return this.table.get({ id });
  }

  list(filter: ProfileListFilter = {}): Promise<readonly ProfileRecord[]> {
    return this.table.select({
      eq: eqTerms({ client: filter.client, kind: filter.kind, provider: filter.provider }),
      in: inTerm('state', filter.states),
      orderBy: [{ field: 'createdAt' }, { field: 'id' }],
    });
  }

  async update(id: string, patch: ProfilePatch): Promise<ProfileRecord> {
    const given = parseOrThrow(ProfilePatchSchema, patch, 'profile patch');
    const current = mustExist(await this.table.get({ id }), 'Profile', id);
    const to = given.state ?? current.state;
    if (to !== current.state && !PROFILE_TRANSITIONS[current.state].includes(to)) {
      throw new Conflict(`Profile ${id} cannot go from ${current.state} to ${to}`);
    }
    const now = this.clock.now();
    const next: ProfileRecord = { ...applyPatch(current, given), updatedAt: now };
    if (to === 'removed' && current.state !== 'removed') next.removedAt = now;
    await this.table.replace(next);
    return next;
  }
}
