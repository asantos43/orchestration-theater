// SPDX-License-Identifier: MPL-2.0
import { Conflict, InvalidInput } from '../errors.js';
import type { Clock } from '../ports/clock.js';
import {
  IDEA_TRANSITIONS,
  IdeaRecordSchema,
  IdeaTransitionSchema,
  NewIdeaSchema,
  type IdeaListFilter,
  type IdeaRecord,
  type IdeaRegistry,
  type IdeaState,
  type IdeaTransition,
  type NewIdea,
} from '../ports/ideas.js';
import type { RecordTable, TableSpec } from './record-table.js';
import { eqTerms, inTerm, mustExist, parseOrThrow } from './support.js';

export const IDEAS_SPEC: TableSpec<IdeaRecord> = {
  name: 'ideas',
  schema: IdeaRecordSchema,
  key: ['id'],
  json: [],
};

const BY_SEQ = [{ field: 'seq' }] as const;

/** `IdeaRegistry` over a {@link RecordTable}. */
export class TableIdeaRegistry implements IdeaRegistry {
  constructor(
    private readonly table: RecordTable<IdeaRecord>,
    private readonly clock: Pick<Clock, 'now'>,
  ) {}

  async create(input: NewIdea): Promise<IdeaRecord> {
    const given = parseOrThrow(NewIdeaSchema, input, 'idea');
    const now = this.clock.now();
    const [last] = await this.table.select({ orderBy: [{ field: 'seq', desc: true }], limit: 1 });
    const seq = (last?.seq ?? 0) + 1;
    const record: IdeaRecord = {
      id: `I${String(seq)}`,
      seq,
      scenarioId: given.scenarioId,
      text: given.text,
      area: given.area ?? null,
      source: given.source ?? 'chat',
      state: 'queued',
      groupId: null,
      groupOrder: null,
      playId: null,
      prNumber: null,
      prUrl: null,
      reason: null,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    };
    await this.table.insert(record);
    return record;
  }

  get(id: string): Promise<IdeaRecord | undefined> {
    return this.table.get({ id });
  }

  list(filter: IdeaListFilter = {}): Promise<readonly IdeaRecord[]> {
    return this.table.select({
      eq: eqTerms({
        scenarioId: filter.scenarioId,
        playId: filter.playId,
        groupId: filter.groupId,
      }),
      in: inTerm('state', filter.states),
      orderBy: BY_SEQ,
    });
  }

  async transition(id: string, to: IdeaState, patch: IdeaTransition = {}): Promise<IdeaRecord> {
    const given = parseOrThrow(IdeaTransitionSchema, patch, 'idea transition');
    const current = mustExist(await this.table.get({ id }), 'Idea', id);
    if (!IDEA_TRANSITIONS[current.state].includes(to)) {
      throw new Conflict(`Idea ${id} cannot go from ${current.state} to ${to}`);
    }
    const now = this.clock.now();
    const next: IdeaRecord = { ...current, state: to, updatedAt: now };
    switch (to) {
      case 'grouped': {
        // A grouped idea goes to `grouped` again to receive the play of its group.
        const groupId = given.groupId ?? current.groupId ?? undefined;
        const groupOrder = given.groupOrder ?? current.groupOrder ?? undefined;
        if (groupId === undefined || groupOrder === undefined) {
          throw new InvalidInput('An idea goes to grouped with a groupId and a groupOrder');
        }
        next.groupId = groupId;
        next.groupOrder = groupOrder;
        // The group may already have its play (it was opened before this idea joined it).
        if (given.playId !== undefined) next.playId = given.playId;
        next.reason = null;
        break;
      }
      case 'done': {
        const playId = given.playId ?? current.playId;
        if (playId === null) throw new InvalidInput('An idea is done with the play that did it');
        next.playId = playId;
        next.prNumber = given.pullRequest?.number ?? null;
        next.prUrl = given.pullRequest?.url ?? null;
        next.closedAt = now;
        break;
      }
      case 'discarded':
      case 'deferred':
        if (given.reason === undefined) throw new InvalidInput(`An idea is ${to} with a reason`);
        next.reason = given.reason;
        if (to === 'discarded') next.closedAt = now;
        break;
      case 'queued':
        next.groupId = null;
        next.groupOrder = null;
        next.playId = null;
        next.prNumber = null;
        next.prUrl = null;
        next.reason = given.reason ?? null;
        break;
    }
    await this.table.replace(next);
    return next;
  }
}
