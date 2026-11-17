// SPDX-License-Identifier: MPL-2.0
import { Conflict, InvalidInput } from '../errors.js';
import type { Clock } from '../ports/clock.js';
import {
  DEFAULT_DIRECTIVE_TIMEZONE,
  DirectiveRecordSchema,
  DirectiveValiditySchema,
  NewDirectiveSchema,
  directiveStateAt,
  type DirectiveForceQuery,
  type DirectiveListFilter,
  type DirectiveRecord,
  type DirectiveRegistry,
  type DirectiveValidity,
  type NewDirective,
} from '../ports/directives.js';
import type { RecordTable, TableSpec } from './record-table.js';
import { applyPatch, eqTerms, inTerm, mustExist, parseOrThrow } from './support.js';

export const DIRECTIVES_SPEC: TableSpec<DirectiveRecord> = {
  name: 'directives',
  schema: DirectiveRecordSchema,
  key: ['id'],
  json: ['roles', 'ruleValue'],
};

const BY_SEQ = [{ field: 'seq' }] as const;

/** `DirectiveRegistry` over a {@link RecordTable}. */
export class TableDirectiveRegistry implements DirectiveRegistry {
  constructor(
    private readonly table: RecordTable<DirectiveRecord>,
    private readonly clock: Pick<Clock, 'now'>,
  ) {}

  async create(input: NewDirective): Promise<DirectiveRecord> {
    const given = parseOrThrow(NewDirectiveSchema, input, 'directive');
    const now = this.clock.now();
    const startsAt = given.startsAt ?? now;
    const endsAt = given.endsAt ?? null;
    const scenarioId = given.scenarioId ?? null;
    const ruleKey = given.ruleKey ?? null;
    const suspendsId = given.suspendsId ?? null;
    const replacesId = given.replacesId ?? null;

    if (given.scope === 'local' && scenarioId === null) {
      throw new InvalidInput('A local directive needs a scenarioId');
    }
    if (given.scope === 'global' && scenarioId !== null) {
      throw new InvalidInput('A global directive has no scenarioId');
    }
    if ((given.kind === 'rule') !== (ruleKey !== null)) {
      throw new InvalidInput('A rule needs a ruleKey, and only a rule has one');
    }
    if ((given.kind === 'suspension') !== (suspendsId !== null)) {
      throw new InvalidInput('A suspension needs suspendsId, and only a suspension has one');
    }
    if (given.kind === 'suspension' && given.scope !== 'local') {
      throw new InvalidInput('A suspension is local to a scenario');
    }
    if (endsAt !== null && endsAt <= startsAt) {
      throw new InvalidInput('The end of the validity must be after its start');
    }
    if (suspendsId !== null) {
      const target = await this.table.get({ id: suspendsId });
      if (target?.scope !== 'global') {
        throw new InvalidInput(`${suspendsId} is not a global directive`);
      }
    }
    if (replacesId !== null && (await this.table.get({ id: replacesId })) === undefined) {
      throw new InvalidInput(`The directive ${replacesId} to replace does not exist`);
    }

    const [last] = await this.table.select({
      orderBy: [{ field: 'seq', desc: true }],
      limit: 1,
    });
    const seq = (last?.seq ?? 0) + 1;
    const record: DirectiveRecord = {
      id: `O${String(seq)}`,
      seq,
      scope: given.scope,
      scenarioId,
      kind: given.kind,
      text: given.text,
      ruleKey,
      ruleValue: given.ruleValue ?? null,
      suspendsId,
      roles: given.roles ?? [],
      startsAt,
      endsAt,
      timezone: given.timezone ?? DEFAULT_DIRECTIVE_TIMEZONE,
      state: directiveStateAt({ startsAt, endsAt, revokedAt: null }, now),
      origin: given.origin,
      replacesId,
      createdAt: now,
      updatedAt: now,
      revokedAt: null,
      revokeReason: null,
    };
    await this.table.insert(record);
    return record;
  }

  get(id: string): Promise<DirectiveRecord | undefined> {
    return this.table.get({ id });
  }

  list(filter: DirectiveListFilter = {}): Promise<readonly DirectiveRecord[]> {
    return this.table.select({
      eq: eqTerms({ scope: filter.scope, scenarioId: filter.scenarioId }),
      in: { ...inTerm('kind', filter.kinds), ...inTerm('state', filter.states) },
      orderBy: BY_SEQ,
    });
  }

  async extend(id: string, validity: DirectiveValidity): Promise<DirectiveRecord> {
    const given = parseOrThrow(DirectiveValiditySchema, validity, 'directive validity');
    const current = mustExist(await this.table.get({ id }), 'Directive', id);
    if (current.state === 'revoked') throw new Conflict(`Directive ${id} is revoked`);
    const now = this.clock.now();
    const startsAt = given.startsAt ?? current.startsAt;
    const endsAt = given.endsAt === undefined ? current.endsAt : given.endsAt;
    if (endsAt !== null && endsAt <= startsAt) {
      throw new InvalidInput('The end of the validity must be after its start');
    }
    const next: DirectiveRecord = {
      ...current,
      startsAt,
      endsAt,
      state: directiveStateAt({ startsAt, endsAt, revokedAt: null }, now),
      updatedAt: now,
    };
    await this.table.replace(next);
    return next;
  }

  async revoke(id: string, reason: string): Promise<DirectiveRecord> {
    const why = parseOrThrow(DirectiveRecordSchema.shape.text, reason, 'revoke reason');
    const current = mustExist(await this.table.get({ id }), 'Directive', id);
    if (current.state === 'revoked') throw new Conflict(`Directive ${id} is already revoked`);
    const now = this.clock.now();
    const next: DirectiveRecord = {
      ...current,
      state: 'revoked',
      revokedAt: now,
      revokeReason: why,
      updatedAt: now,
    };
    await this.table.replace(next);
    return next;
  }

  async refreshStates(): Promise<readonly DirectiveRecord[]> {
    const now = this.clock.now();
    const open = await this.table.select({
      in: inTerm('state', ['scheduled', 'active']),
      orderBy: BY_SEQ,
    });
    const changed: DirectiveRecord[] = [];
    for (const directive of open) {
      const state = directiveStateAt(directive, now);
      if (state === directive.state) continue;
      const next = { ...applyPatch(directive, { state }), updatedAt: now };
      await this.table.replace(next);
      changed.push(next);
    }
    return changed;
  }

  async inForce(query: DirectiveForceQuery): Promise<readonly DirectiveRecord[]> {
    const now = this.clock.now();
    const all = await this.table.select({ orderBy: BY_SEQ });
    const active = all.filter(
      (directive) =>
        directiveStateAt(directive, now) === 'active' &&
        (directive.scope === 'global' || directive.scenarioId === query.scenarioId) &&
        (query.role === undefined ||
          directive.roles.length === 0 ||
          directive.roles.includes(query.role)),
    );
    const suspended = new Set(
      active
        .filter((directive) => directive.kind === 'suspension')
        .map((directive) => directive.suspendsId),
    );
    return active.filter((directive) => !suspended.has(directive.id));
  }
}
