// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';

/**
 * Payloads of the events of the conversation between Executors (N308; plan of Phase 11b, P13).
 * Registered in `DAEMON_EVENT_DEFINITIONS` (events.ts) at `schemaVersion` 1; strict objects. The
 * scenario, the play and the attempt are in the envelope. [proposta] The names of the fields. A
 * note's text is not in the event: it lives in the blackboard of the play (`notes/<demand>`), so
 * a hook sees that a note was posted and reads it from there when it may.
 */

/** The features of the conversation: the notes board (P13) and `ask_director` (P15). */
export const COLLAB_FEATURES = ['notes', 'ask_director'] as const;
export type CollabFeature = (typeof COLLAB_FEATURES)[number];

/** The limits a feature can reach. */
export const COLLAB_LIMITS = ['max_per_actor', 'max_chars', 'max_per_demand'] as const;
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

/** `collab.limit_reached`: a note or a question (`ask_director`) was refused by a limit. */
export const CollabLimitReachedPayloadSchema = z.strictObject({
  feature: z.enum(COLLAB_FEATURES),
  limit: z.enum(COLLAB_LIMITS),
  demandId: z.string().min(1),
  /** The value the call would have reached (the count of notes, or the length of the text). */
  value: z.int().min(0),
  max: z.int().min(0),
});

/**
 * How a question was answered (P15, [proposta]): `director` (the Director's own answer, in the
 * mode `answer`, or in `relay` when it knew the answer itself) or `actor` (the Actor that owns the
 * information, relayed through the channel of the supervision, in the mode `relay`).
 */
export const QUESTION_ANSWER_SOURCES = ['director', 'actor'] as const;
export type QuestionAnswerSource = (typeof QUESTION_ANSWER_SOURCES)[number];

/** `collab.ask_director.mode` as an event carries it: `off` never asks, so it never shows here. */
export const QUESTION_MODES = ['answer', 'relay'] as const;

/** What the deadline does (`collab.ask_director.on_timeout`). */
export const QUESTION_ON_TIMEOUT = ['blocked', 'continue'] as const;

/**
 * `actor.question` (N308, option 2; plan of Phase 11b, P15): an Actor asked the Director. The text
 * of the question is not in the event: it lives in the blackboard of the play
 * (`questions/<demand>`, one version per question), so a hook sees that a question went and reads
 * it from there when it may.
 */
export const ActorQuestionPayloadSchema = z.strictObject({
  questionId: z.string().min(1),
  demandId: z.string().min(1),
  mode: z.enum(QUESTION_MODES),
  chars: z.int().min(1),
  /** The number of the question in its demand (1 for the first), and the limit it counts against. */
  number: z.int().min(1),
  max: z.int().min(0),
  /** The longest the Actor waits, in ms (`collab.ask_director.timeout`). */
  timeoutMs: z.int().min(0),
});

/** `actor.answer`: the question got its answer and the wait ended. */
export const ActorAnswerPayloadSchema = z.strictObject({
  questionId: z.string().min(1),
  demandId: z.string().min(1),
  source: z.enum(QUESTION_ANSWER_SOURCES),
  chars: z.int().min(0),
  /** How long the Actor waited, in ms (by the `Clock`). */
  waitedMs: z.int().min(0),
});

/** `actor.question_timeout`: the deadline passed with no answer; `onTimeout` is what followed. */
export const ActorQuestionTimeoutPayloadSchema = z.strictObject({
  questionId: z.string().min(1),
  demandId: z.string().min(1),
  onTimeout: z.enum(QUESTION_ON_TIMEOUT),
  waitedMs: z.int().min(0),
});
