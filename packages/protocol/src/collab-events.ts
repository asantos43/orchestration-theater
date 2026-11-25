// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';

/**
 * Payloads of the events of the conversation between Executors (N308; plan of Phase 11b, P13).
 * Registered in `DAEMON_EVENT_DEFINITIONS` (events.ts) at `schemaVersion` 1; strict objects. The
 * scenario, the play and the attempt are in the envelope. [proposta] The names of the fields. A
 * note's text is not in the event: it lives in the blackboard of the play (`notes/<demand>`), so
 * a hook sees that a note was posted and reads it from there when it may.
 */

/** The features of the conversation; P15 adds `ask_director`. */
export const COLLAB_FEATURES = ['notes'] as const;
export type CollabFeature = (typeof COLLAB_FEATURES)[number];

/** The limits a feature can reach. */
export const COLLAB_LIMITS = ['max_per_actor', 'max_chars'] as const;
export type CollabLimit = (typeof COLLAB_LIMITS)[number];

/** `note.posted`: an Actor left a note on the board of its play. */
export const NotePostedPayloadSchema = z.strictObject({
  /** The demand of the Actor that wrote it. */
  demandId: z.string().min(1),
  /** The blackboard key and the version the note took (`notes/<demand>`). */
  key: z.string().min(1),
  version: z.int().min(1),
  chars: z.int().min(1),
});

/** `collab.limit_reached`: a note (or, from P15, a question) was refused by a limit. */
export const CollabLimitReachedPayloadSchema = z.strictObject({
  feature: z.enum(COLLAB_FEATURES),
  limit: z.enum(COLLAB_LIMITS),
  demandId: z.string().min(1),
  /** The value the call would have reached (the count of notes, or the length of the text). */
  value: z.int().min(0),
  max: z.int().min(0),
});
