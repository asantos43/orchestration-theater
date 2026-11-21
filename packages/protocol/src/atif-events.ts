// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';

/**
 * Payloads of the events of the ATIF export (Phase 8, P5; architecture 5.11, N219). Registered in
 * `DAEMON_EVENT_DEFINITIONS` (events.ts) at `schemaVersion` 1; strict objects. [proposta] The two
 * event names and every field; the architecture only says that a file is written per play. The
 * scenario and the play are in the envelope (`scenarioId`, `playId`). Neither payload carries the
 * content of a trajectory: the file is where the content is.
 */

/** What an export covers: the whole play (the Director and its attempts), or one attempt. */
export const ATIF_EXPORT_UNITS = ['play', 'attempt', 'play_files'] as const;
export type AtifExportUnit = (typeof ATIF_EXPORT_UNITS)[number];

/** `full`: the text as it was (secrets masked all the same); `redacted`: structure and metrics, no text. */
export const ATIF_EXPORT_CONTENTS = ['full', 'redacted'] as const;
export type AtifExportContent = (typeof ATIF_EXPORT_CONTENTS)[number];

/** When the daemon writes a file: when the play ends, when an attempt ends, or only when asked. */
export const ATIF_EXPORT_TRIGGERS = ['play_end', 'attempt_end', 'manual'] as const;
export type AtifExportTrigger = (typeof ATIF_EXPORT_TRIGGERS)[number];

/** `atif.exported`: a trajectory file was written. */
export const AtifExportedPayloadSchema = z.strictObject({
  /** `play`: one file for the play; `attempt`: the file of one attempt (`attemptId` is set). */
  unit: z.enum(['play', 'attempt']),
  attemptId: z.string().min(1).nullable(),
  on: z.enum(ATIF_EXPORT_TRIGGERS),
  content: z.enum(ATIF_EXPORT_CONTENTS),
  /** Relative to the data folder when inside it, else absolute. */
  path: z.string().min(1).max(4096),
  bytes: z.int().min(0),
  steps: z.int().min(0),
  /** The attempts the file holds (embedded or referenced). */
  attempts: z.int().min(0),
});

/** Why an export did not produce a file. */
export const ATIF_EXPORT_FAILURES = [
  'play_not_found',
  'attempt_not_found',
  'build_failed',
  'invalid_trajectory',
  /** `content: full` needs the values of the vault to mask them; the vault could not be read. */
  'vault_unavailable',
  'write_failed',
] as const;
export type AtifExportFailure = (typeof ATIF_EXPORT_FAILURES)[number];

/** `atif.export_failed`: a trigger fired and no file came out; the play itself is not affected. */
export const AtifExportFailedPayloadSchema = z.strictObject({
  unit: z.enum(ATIF_EXPORT_UNITS),
  attemptId: z.string().min(1).nullable(),
  on: z.enum(ATIF_EXPORT_TRIGGERS),
  reason: z.enum(ATIF_EXPORT_FAILURES),
  /** Short, with no content of the trajectory. */
  detail: z.string().max(512).nullable(),
});
