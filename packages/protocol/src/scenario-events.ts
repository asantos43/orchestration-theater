// SPDX-License-Identifier: MPL-2.0
import { ATTACHMENT_SOURCES } from '@otheater/core';
import { z } from 'zod';

/**
 * Payloads of the `scenario.*` events (architecture 5.20, "Eventos"). Registered in
 * `DAEMON_EVENT_DEFINITIONS` (events.ts) at `schemaVersion` 1. Every payload is a strict object;
 * the scenario also travels in the envelope (`scenarioId`).
 * [proposta] The fields below, in camelCase like the other payloads of the daemon. The import and
 * the promotion of a scenario (also listed by 5.20) belong to later steps and have no event yet.
 */

const scenarioId = z.string().min(1);

/** The states of the `chat` flow (architecture 5.20): the long-lived play of the generic chat. */
export const CHAT_FLOW_STATES = ['IDLE', 'CONSULTING', 'AWAITING_PRODUCER'] as const;
export type ChatFlowState = (typeof CHAT_FLOW_STATES)[number];

/** `scenario.created`: a scenario of a registered type was opened (`ot chat`, `ot new`...). */
export const ScenarioCreatedPayloadSchema = z.strictObject({
  scenarioId,
  type: z.string().min(1),
  flow: z.string().min(1),
  name: z.string().min(1),
  folder: z.string().min(1),
});

/** `scenario.attachment_added`: a file, a pasted text or a path became attachment `A<n>`. */
export const ScenarioAttachmentAddedPayloadSchema = z.strictObject({
  scenarioId,
  /** `A<n>`. */
  attachmentId: z.string().regex(/^A[1-9][0-9]*$/),
  name: z.string().min(1),
  mime: z.string().min(1),
  size: z.int().min(0),
  hash: z.string().min(1),
  source: z.enum(ATTACHMENT_SOURCES),
});

/** `scenario.director_slept`: the Director idled for `idleMs` and its session was closed. */
export const ScenarioDirectorSleptPayloadSchema = z.strictObject({
  scenarioId,
  /** The `scenarios.director_idle_after` the Director slept under. */
  idleMs: z.int().min(1),
});

/** `scenario.director_woke`: a session opened again; the state summary went in its first prompt. */
export const ScenarioDirectorWokePayloadSchema = z.strictObject({
  scenarioId,
  /** Epoch ms the Director fell asleep at, `null` when it was never recorded. */
  sleptAt: z.int().min(0).nullable(),
});

/**
 * `scenario.chat_transitioned`: the `chat` flow of a scenario moved (IDLE, CONSULTING,
 * AWAITING_PRODUCER). A consultation records which Executor was chosen and why.
 */
export const ScenarioChatTransitionedPayloadSchema = z.strictObject({
  scenarioId,
  from: z.enum(CHAT_FLOW_STATES),
  to: z.enum(CHAT_FLOW_STATES),
  /** The decision of the consultation, when the move is one. */
  decisionId: z.string().min(1).nullable(),
  /** Why the move happened: `consult`, `consult_answered`, `consult_failed`, `ask_producer`... */
  cause: z.string().min(1),
  /** The Executor the consultation uses (`client/profile`), for `consult`. */
  executor: z.string().min(1).nullable(),
  /** Why that Executor (the Director's reason, a forced choice, the only one with image...). */
  reason: z.string().nullable(),
});
