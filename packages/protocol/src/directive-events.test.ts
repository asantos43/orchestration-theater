// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  DirectiveCreatedPayloadSchema,
  DirectiveExpiredPayloadSchema,
  DirectiveRevokedPayloadSchema,
  DirectiveSuspendedPayloadSchema,
  DirectiveValidityChangedPayloadSchema,
} from './directive-events.js';
import { buildDaemonEvent, validateEventPayload } from './events.js';

const created = {
  directiveId: 'O1',
  scope: 'global',
  scenarioId: null,
  kind: 'instruction',
  roles: [],
  startsAt: 1_000,
  endsAt: null,
  timezone: 'America/Sao_Paulo',
  state: 'active',
  origin: 'chat',
  ruleKey: null,
  suspendsId: null,
  replacesId: null,
};

describe('directive event payloads (architecture 5.17)', () => {
  it('accepts a created order and rejects an id that is not O<n>', () => {
    expect(DirectiveCreatedPayloadSchema.parse(created)).toEqual(created);
    expect(DirectiveCreatedPayloadSchema.safeParse({ ...created, directiveId: 'D1' }).success).toBe(
      false,
    );
    expect(DirectiveCreatedPayloadSchema.safeParse({ ...created, extra: 1 }).success).toBe(false);
  });

  it('may carry the whole record of the order, and only a whole one', () => {
    const order = {
      id: 'O1',
      seq: 1,
      scope: 'global',
      scenarioId: null,
      kind: 'instruction',
      text: 'Be brief.',
      ruleKey: null,
      ruleValue: null,
      suspendsId: null,
      roles: [],
      startsAt: 1_000,
      endsAt: null,
      timezone: 'America/Sao_Paulo',
      state: 'active',
      origin: 'chat',
      replacesId: null,
      createdAt: 1_000,
      updatedAt: 1_000,
      revokedAt: null,
      revokeReason: null,
    };
    expect(DirectiveCreatedPayloadSchema.parse({ ...created, order })).toEqual({
      ...created,
      order,
    });
    expect(
      DirectiveCreatedPayloadSchema.safeParse({ ...created, order: { id: 'O1' } }).success,
    ).toBe(false);
  });

  it('keeps the real boundary in the activated and expired events', () => {
    const payload = { directiveId: 'O2', effectiveAt: 5_000 };
    expect(validateEventPayload('directive.activated', 1, payload)).toEqual(payload);
    expect(DirectiveExpiredPayloadSchema.parse(payload)).toEqual(payload);
  });

  it('requires a reason to revoke', () => {
    const payload = { directiveId: 'O2', reason: 'no longer wanted', revokedAt: 9 };
    expect(DirectiveRevokedPayloadSchema.parse(payload)).toEqual(payload);
    expect(DirectiveRevokedPayloadSchema.safeParse({ ...payload, reason: '' }).success).toBe(false);
  });

  it('carries the old and the new validity of an extension', () => {
    const payload = {
      directiveId: 'O3',
      startsAt: 1,
      endsAt: 20,
      previousStartsAt: 1,
      previousEndsAt: 10,
    };
    expect(DirectiveValidityChangedPayloadSchema.parse(payload)).toEqual(payload);
    expect(
      DirectiveValidityChangedPayloadSchema.parse({
        ...payload,
        endsAt: null,
        previousEndsAt: null,
      }),
    ).toMatchObject({ endsAt: null });
  });

  it('ties a suspension to the global order and the scenario it affects', () => {
    const payload = { directiveId: 'O5', suspendsId: 'O1', scenarioId: 's1' };
    expect(DirectiveSuspendedPayloadSchema.parse(payload)).toEqual(payload);
    expect(buildDaemonEvent('directive.suspended', payload).type).toBe('directive.suspended');
  });

  it('builds the notice event with the advance it was configured with', () => {
    const event = buildDaemonEvent('directive.expiring', {
      directiveId: 'O2',
      endsAt: 10,
      noticeMs: 86_400_000,
    });
    expect(event).toMatchObject({ type: 'directive.expiring', schemaVersion: 1 });
  });
});
