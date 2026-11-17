// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';
import { EpochMsSchema, RecordIdSchema } from './store-schemas.js';

/** State of an ACP session (architecture section 7, `sessions`). */
export const SESSION_STATES = [
  'active',
  'interrupted',
  'awaiting_resume',
  'resuming',
  'closed',
] as const;
export type SessionState = (typeof SESSION_STATES)[number];

const text = z.string().min(1);

/**
 * One row of `sessions`: an ACP session and the process behind it. The pid and the instant the
 * process started identify it across a restart, so the daemon can find orphans on start-up
 * (5.21): a recycled pid has a different start instant.
 */
export const SessionRecordSchema = z.strictObject({
  id: RecordIdSchema,
  client: text,
  profile: text,
  role: text.nullable(),
  attemptId: RecordIdSchema.nullable(),
  worktree: text.nullable(),
  /** Id of the session in the client, for `session/load`. */
  clientSessionId: text.nullable(),
  pid: z.int().min(1).nullable(),
  /** Epoch milliseconds at which the process started, as the operating system reports it. */
  processStartedAt: EpochMsSchema.nullable(),
  state: z.enum(SESSION_STATES),
  createdAt: EpochMsSchema,
  updatedAt: EpochMsSchema,
  /** Set when the session reaches `closed`. */
  endedAt: EpochMsSchema.nullable(),
});
export type SessionRecord = z.infer<typeof SessionRecordSchema>;

export const NewSessionSchema = SessionRecordSchema.omit({
  createdAt: true,
  updatedAt: true,
  endedAt: true,
}).partial({
  role: true,
  attemptId: true,
  worktree: true,
  clientSessionId: true,
  pid: true,
  processStartedAt: true,
  state: true,
});
export type NewSession = z.infer<typeof NewSessionSchema>;

/** The fields of a session that change after it opened. */
export const SessionPatchSchema = SessionRecordSchema.pick({
  attemptId: true,
  worktree: true,
  clientSessionId: true,
  pid: true,
  processStartedAt: true,
  state: true,
}).partial();
export type SessionPatch = z.infer<typeof SessionPatchSchema>;

export interface SessionListFilter {
  readonly states?: readonly SessionState[];
  readonly attemptId?: string;
  readonly client?: string;
  readonly profile?: string;
}

/**
 * Registry of sessions, part of `Store`. Contract (`describeSessionConformance`): `open` records
 * the session (default state `active`; an existing id rejects with `Conflict`); `update` changes
 * only {@link SessionPatch} (`NotFound` for an unknown id), bumps `updatedAt` and stamps
 * `endedAt` when the session becomes `closed`; `list` is ordered by `createdAt`, then `id`.
 */
export interface SessionRegistry {
  open(input: NewSession): Promise<SessionRecord>;
  get(id: string): Promise<SessionRecord | undefined>;
  list(filter?: SessionListFilter): Promise<readonly SessionRecord[]>;
  update(id: string, patch: SessionPatch): Promise<SessionRecord>;
}
