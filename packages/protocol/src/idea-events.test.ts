// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { buildDaemonEvent, validateEventPayload } from './events.js';
import {
  IdeaAddedPayloadSchema,
  IdeaDiscardedPayloadSchema,
  IdeaDonePayloadSchema,
  IdeaGroupedPayloadSchema,
  IdeaReturnedPayloadSchema,
} from './idea-events.js';

describe('idea event payloads (architecture 5.20)', () => {
  it('accepts an added idea and rejects an id that is not I<n>', () => {
    const added = { ideaId: 'I1', scenarioId: 'scn-1', source: 'chat', area: null };
    expect(IdeaAddedPayloadSchema.parse(added)).toEqual(added);
    expect(IdeaAddedPayloadSchema.safeParse({ ...added, ideaId: 'D1' }).success).toBe(false);
    expect(IdeaAddedPayloadSchema.safeParse({ ...added, extra: 1 }).success).toBe(false);
  });

  it('a group has at least one idea and says whether it waits for the Producer', () => {
    const grouped = {
      groupId: 'g-1',
      scenarioId: 'scn-1',
      ideaIds: ['I1', 'I2'],
      need: 'Do I1 and I2',
      awaitingApproval: true,
    };
    expect(validateEventPayload('idea.grouped', 1, grouped)).toEqual(grouped);
    expect(IdeaGroupedPayloadSchema.safeParse({ ...grouped, ideaIds: [] }).success).toBe(false);
  });

  it('discarding and returning always carry a reason', () => {
    expect(IdeaDiscardedPayloadSchema.safeParse({ ideaId: 'I1', by: 'author' }).success).toBe(
      false,
    );
    expect(
      IdeaDiscardedPayloadSchema.safeParse({ ideaId: 'I1', by: 'author', reason: '' }).success,
    ).toBe(false);
    expect(
      IdeaReturnedPayloadSchema.parse({ ideaId: 'I1', playId: null, reason: 'group refused' }),
    ).toEqual({ ideaId: 'I1', playId: null, reason: 'group refused' });
  });

  it('done links the play and, when there is one, the pull request', () => {
    const done = {
      ideaId: 'I1',
      playId: 'play-1',
      pullRequest: { number: 4, url: 'https://example.test/pr/4' },
    };
    expect(IdeaDonePayloadSchema.parse(done)).toEqual(done);
    expect(IdeaDonePayloadSchema.parse({ ...done, pullRequest: null }).pullRequest).toBeNull();
  });

  it('buildDaemonEvent builds the envelope of an idea event', () => {
    const event = buildDaemonEvent('idea.deferred', {
      ideaId: 'I2',
      reason: 'later',
      by: 'producer',
    });
    expect(event.type).toBe('idea.deferred');
    expect(event.schemaVersion).toBe(1);
  });
});
