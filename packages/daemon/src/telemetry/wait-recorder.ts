// SPDX-License-Identifier: MPL-2.0
import type { JsonValue } from '@otheater/core';
import { WAIT_KIND } from './span-conventions.js';

/**
 * Where the daemon waits and the log says nothing (Phase 8, P4, N217 (a)): the queue of prompts and
 * the queue of the session pool. The place that waits tells the end of the wait here, with the
 * times of its own clock, and the spans of the daemon turn it into an `otheater.wait` span. No event
 * is written for it (N217 (a)), so these spans are not rebuilt when the log is projected again.
 * [proposta]
 */

/** The waits that are recorded where they happen. */
export type DirectWaitKind = typeof WAIT_KIND.promptQueue | typeof WAIT_KIND.poolAdmission;

/** The ids of the log a wait can be tied to. Every one is optional: a prompt has no attempt yet. */
export interface DirectWaitCorrelation {
  readonly scenarioId?: string | undefined;
  readonly playId?: string | undefined;
  readonly attemptId?: string | undefined;
  readonly role?: string | undefined;
  readonly client?: string | undefined;
  readonly profile?: string | undefined;
}

/** One finished wait. */
export interface DirectWait {
  readonly kind: DirectWaitKind;
  /** What makes it this wait: the id of the prompt, or of the request to the pool. */
  readonly key: string;
  readonly startMs: number;
  readonly endMs: number;
  /** Why it waited, in the words of the place that waited (`max_sessions`, `ram`, `quota`...). */
  readonly reason: string;
  /** How it ended (`delivered`, `admitted`, `cancelled`...). */
  readonly outcome: string;
  readonly correlation?: DirectWaitCorrelation | undefined;
  /** Extra attributes, already free of content (an id, a priority, a count). */
  readonly attributes?: Readonly<Record<string, JsonValue>> | undefined;
}

/** What a module that waits is given. It never throws and never waits. */
export type WaitRecorder = (wait: DirectWait) => void;
