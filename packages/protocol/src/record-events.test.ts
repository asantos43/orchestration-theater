// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { buildDaemonEvent } from './events.js';
import {
  DecisionAnsweredPayloadSchema,
  DecisionCreatedPayloadSchema,
  DemandTransitionedPayloadSchema,
  ScenarioArchivedPayloadSchema,
} from './record-events.js';

const decision = {
  id: 'd1',
  scenarioId: 's1',
  playId: 'p1',
  kind: 'producer_question',
  input: { questions: [] },
  answer: null,
  decidedBy: null,
  state: 'pending',
  createdAt: 10,
  updatedAt: 10,
  decidedAt: null,
};

const demand = {
  playId: 'p1',
  id: 'a',
  title: 'A',
  description: '',
  dependsOn: [],
  contract: { inputs: [], outputs: [] },
  expectedFiles: [],
  complexity: 'low',
  specialty: null,
  timeoutMin: 5,
  acceptanceCriteria: [],
  verify: [],
  verifyWaiver: null,
  state: 'pending',
  createdAt: 10,
  updatedAt: 10,
};

describe('the events of the records (P1 of docs/18, N173)', () => {
  it('decision.created carries the whole record, strictly', () => {
    expect(DecisionCreatedPayloadSchema.parse({ decision })).toEqual({ decision });
    expect(DecisionCreatedPayloadSchema.safeParse({ decision, extra: 1 }).success).toBe(false);
    expect(
      DecisionCreatedPayloadSchema.safeParse({ decision: { ...decision, id: '' } }).success,
    ).toBe(false);
  });

  it('decision.answered says decided or cancelled, never pending, and carries no answer', () => {
    const payload = {
      decisionId: 'd1',
      kind: 'producer_question',
      state: 'decided',
      decidedBy: 'producer',
    };
    expect(DecisionAnsweredPayloadSchema.parse(payload)).toEqual(payload);
    expect(
      DecisionAnsweredPayloadSchema.parse({ ...payload, state: 'cancelled', decidedBy: null })
        .state,
    ).toBe('cancelled');
    expect(DecisionAnsweredPayloadSchema.safeParse({ ...payload, state: 'pending' }).success).toBe(
      false,
    );
    expect(DecisionAnsweredPayloadSchema.safeParse({ ...payload, answer: {} }).success).toBe(false);
  });

  it('scenario.archived carries the scenario id only', () => {
    expect(ScenarioArchivedPayloadSchema.parse({ scenarioId: 's1' })).toEqual({ scenarioId: 's1' });
    expect(ScenarioArchivedPayloadSchema.safeParse({ scenarioId: '' }).success).toBe(false);
    expect(ScenarioArchivedPayloadSchema.safeParse({ scenarioId: 's1', x: 1 }).success).toBe(false);
  });

  it('demand.transitioned: the birth carries the record, a later move only the states', () => {
    const born = { playId: 'p1', demandId: 'a', from: null, to: 'pending', demand };
    expect(DemandTransitionedPayloadSchema.parse(born)).toEqual(born);
    const moved = { playId: 'p1', demandId: 'a', from: 'pending', to: 'ready' };
    expect(DemandTransitionedPayloadSchema.parse(moved)).toEqual(moved);
    expect(DemandTransitionedPayloadSchema.safeParse({ ...moved, to: 'flying' }).success).toBe(
      false,
    );
    expect(DemandTransitionedPayloadSchema.safeParse({ ...moved, extra: 1 }).success).toBe(false);
  });

  it('the four types are built by buildDaemonEvent at schemaVersion 1', () => {
    const built = buildDaemonEvent('scenario.archived', { scenarioId: 's1' });
    expect(built).toMatchObject({ type: 'scenario.archived', schemaVersion: 1 });
    expect(
      buildDaemonEvent('decision.created', { decision: { ...decision, state: 'pending' } } as never)
        .type,
    ).toBe('decision.created');
  });
});
