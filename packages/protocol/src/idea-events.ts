// SPDX-License-Identifier: MPL-2.0
import { IDEA_SOURCES } from '@otheater/core';
import { z } from 'zod';

/**
 * Payloads of the `idea.*` events (architecture 5.20, "Eventos"; decision N91). Registered in
 * `DAEMON_EVENT_DEFINITIONS` (events.ts) at `schemaVersion` 1. Every payload is a strict object;
 * the scenario also travels in the envelope (`scenarioId`).
 * [proposta] The fields below, in camelCase like the other payloads of the daemon. The names
 * `idea.added`, `idea.grouped`, `idea.discarded`, `idea.deferred` and `idea.done` are the ones the
 * architecture lists; `idea.play_opened` and `idea.returned` are additions of P8.
 */

const ideaId = z.string().regex(/^I[1-9][0-9]*$/);
const groupId = z.string().min(1);

/** `idea.added`: an idea entered the queue of the scenario. */
export const IdeaAddedPayloadSchema = z.strictObject({
  ideaId,
  scenarioId: z.string().min(1),
  source: z.enum(IDEA_SOURCES),
  area: z.string().min(1).nullable(),
});

/**
 * `idea.grouped`: the Author put ideas in a group (`group_ideas`). `ideaIds` is in the order the
 * Author gave. `awaitingApproval` is true while the group waits for the Producer
 * (`ideas.grouping_approval: ask`).
 */
export const IdeaGroupedPayloadSchema = z.strictObject({
  groupId,
  scenarioId: z.string().min(1),
  ideaIds: z.array(ideaId).min(1),
  /** The need the group became (what the play receives). */
  need: z.string().min(1),
  awaitingApproval: z.boolean(),
  /** The ideas the Author left out of this group, each with the reason (and a question, if any). */
  leftOut: z
    .array(
      z.strictObject({
        ideaId,
        reason: z.string().min(1),
        question: z.string().min(1).optional(),
      }),
    )
    .default([]),
});

/** `idea.play_opened`: the group became the need of a play (approved, or automatic). */
export const IdeaPlayOpenedPayloadSchema = z.strictObject({
  groupId,
  scenarioId: z.string().min(1),
  playId: z.string().min(1),
  ideaIds: z.array(ideaId).min(1),
  approval: z.enum(['ask', 'auto']),
});

/** `idea.discarded`: left out for good, always with the reason. */
export const IdeaDiscardedPayloadSchema = z.strictObject({
  ideaId,
  reason: z.string().min(1),
  /** Who decided: the Author in a grouping, or the Producer. */
  by: z.enum(['author', 'producer']),
});

/** `idea.deferred`: left for later, always with the reason. */
export const IdeaDeferredPayloadSchema = z.strictObject({
  ideaId,
  reason: z.string().min(1),
  by: z.enum(['author', 'producer']),
});

/** `idea.done`: the play delivered the idea; `pullRequest` is null when it did not open one. */
export const IdeaDonePayloadSchema = z.strictObject({
  ideaId,
  playId: z.string().min(1),
  pullRequest: z.strictObject({ number: z.int().min(1), url: z.string().min(1) }).nullable(),
});

/**
 * `idea.returned`: the idea went back to the queue, because its play was cancelled or ended
 * without delivery, or the Producer refused the group, or a deferred idea was taken out of the
 * deferral.
 */
export const IdeaReturnedPayloadSchema = z.strictObject({
  ideaId,
  playId: z.string().min(1).nullable(),
  reason: z.string().min(1),
});
