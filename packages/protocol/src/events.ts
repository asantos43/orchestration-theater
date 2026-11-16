// SPDX-License-Identifier: MPL-2.0
import { InvalidInput, type NewEvent } from '@otheater/core';
import { z } from 'zod';
import { BACKUP_TRIGGERS } from './api.js';
import {
  AttemptCheckpointPayloadSchema,
  SessionClosedPayloadSchema,
  SessionCancelEscalatedPayloadSchema,
  SessionInterruptedPayloadSchema,
  SessionOpenedPayloadSchema,
  SessionPromptFinishedPayloadSchema,
  SessionResumedPayloadSchema,
  SessionUpdatePayloadSchema,
} from './session-events.js';

/**
 * Registry of the event types the daemon itself writes (architecture 5.18, "Registros"). The
 * `EventLog` port only checks the envelope; the schema of each payload, per type and
 * `schemaVersion`, is checked here before the event is appended.
 *
 * Every payload is a strict object: an unknown field is an error, so a typo does not slip into
 * the log and a new field needs a new `schemaVersion`.
 */

const AdapterRefSchema = z.strictObject({
  /** Adapter id as written in the configuration (`sqlite`, `keyring`, `system`). */
  id: z.string().min(1),
  /** Version of the port contract the daemon runs with (not the adapter package version). */
  portVersion: z.string().min(1),
});

/** [proposta] Fields of `daemon.started`. */
export const DaemonStartedPayloadSchema = z.strictObject({
  pid: z.int().min(1),
  version: z.string().min(1),
  dataDir: z.string().min(1),
  adapters: z.strictObject({
    store: AdapterRefSchema,
    vault: AdapterRefSchema,
    clock: AdapterRefSchema,
  }),
});

export const DAEMON_STOP_REASONS = ['signal', 'shutdown', 'error'] as const;

/** [proposta] Fields of `daemon.stopped`. */
export const DaemonStoppedPayloadSchema = z.strictObject({
  reason: z.enum(DAEMON_STOP_REASONS),
  uptimeMs: z.int().min(0),
});

/** [proposta] Fields of `daemon.backup`: one event per backup attempt, good or failed. */
export const DaemonBackupPayloadSchema = z.strictObject({
  ok: z.boolean(),
  trigger: z.enum(BACKUP_TRIGGERS),
  /** Folder of the finished copy (only when `ok`). */
  path: z.string().min(1).optional(),
  method: z.string().min(1).optional(),
  durationMs: z.number().min(0).optional(),
  bytes: z.int().min(0).optional(),
  /** Times the online copy started over because the store changed under it. */
  restarts: z.int().min(0).optional(),
  integrity: z.literal('ok').optional(),
  /** Only when not `ok`. */
  error: z.strictObject({ code: z.string().min(1), message: z.string() }).optional(),
  /** Names of the old copies the rotation removed after a good copy. */
  removed: z.array(z.string()),
});

export const DAEMON_EVENT_TYPES = {
  'daemon.started': { schemaVersion: 1, payload: DaemonStartedPayloadSchema },
  'daemon.stopped': { schemaVersion: 1, payload: DaemonStoppedPayloadSchema },
  'daemon.backup': { schemaVersion: 1, payload: DaemonBackupPayloadSchema },
  'session.opened': { schemaVersion: 1, payload: SessionOpenedPayloadSchema },
  'session.update': { schemaVersion: 1, payload: SessionUpdatePayloadSchema },
  'session.prompt_finished': { schemaVersion: 1, payload: SessionPromptFinishedPayloadSchema },
  'session.interrupted': { schemaVersion: 1, payload: SessionInterruptedPayloadSchema },
  'session.resumed': { schemaVersion: 1, payload: SessionResumedPayloadSchema },
  'session.cancel_escalated': { schemaVersion: 1, payload: SessionCancelEscalatedPayloadSchema },
  'session.closed': { schemaVersion: 1, payload: SessionClosedPayloadSchema },
  'attempt.checkpoint': { schemaVersion: 1, payload: AttemptCheckpointPayloadSchema },
} as const;

export type DaemonEventType = keyof typeof DAEMON_EVENT_TYPES;

export type DaemonEventPayloads = {
  [T in DaemonEventType]: z.infer<(typeof DAEMON_EVENT_TYPES)[T]['payload']>;
};

export type DaemonStartedPayload = DaemonEventPayloads['daemon.started'];
export type DaemonStoppedPayload = DaemonEventPayloads['daemon.stopped'];
export type DaemonBackupPayload = DaemonEventPayloads['daemon.backup'];
export type SessionOpenedPayload = DaemonEventPayloads['session.opened'];
export type SessionUpdatePayload = DaemonEventPayloads['session.update'];
export type SessionPromptFinishedPayload = DaemonEventPayloads['session.prompt_finished'];
export type SessionInterruptedPayload = DaemonEventPayloads['session.interrupted'];
export type SessionResumedPayload = DaemonEventPayloads['session.resumed'];
export type SessionCancelEscalatedPayload = DaemonEventPayloads['session.cancel_escalated'];
export type SessionClosedPayload = DaemonEventPayloads['session.closed'];
export type AttemptCheckpointPayload = DaemonEventPayloads['attempt.checkpoint'];

export function isDaemonEventType(type: string): type is DaemonEventType {
  return Object.hasOwn(DAEMON_EVENT_TYPES, type);
}

/**
 * Checks `payload` against the registry entry of (`type`, `schemaVersion`) and returns the parsed
 * payload. Rejects with `InvalidInput` for an unknown type, a version the registry does not know
 * and a payload that fails its schema.
 */
export function validateEventPayload(
  type: string,
  schemaVersion: number,
  payload: unknown,
): DaemonEventPayloads[DaemonEventType] {
  if (!isDaemonEventType(type)) {
    throw new InvalidInput(`Unknown daemon event type: ${type}`);
  }
  const entry = DAEMON_EVENT_TYPES[type];
  if (entry.schemaVersion !== schemaVersion) {
    throw new InvalidInput(
      `Unsupported schemaVersion ${String(schemaVersion)} for ${type} (the registry has ${String(entry.schemaVersion)})`,
    );
  }
  const result = entry.payload.safeParse(payload);
  if (!result.success) {
    throw new InvalidInput(`Invalid ${type} payload: ${z.prettifyError(result.error)}`, {
      cause: result.error,
    });
  }
  return result.data;
}

/**
 * Builds the {@link NewEvent} of a daemon event: current `schemaVersion` of the type, payload
 * validated first. This is the way the daemon appends its own events.
 */
export function buildDaemonEvent<T extends DaemonEventType>(
  type: T,
  payload: DaemonEventPayloads[T],
): NewEvent {
  const entry = DAEMON_EVENT_TYPES[type];
  const checked = validateEventPayload(type, entry.schemaVersion, payload);
  return { type, schemaVersion: entry.schemaVersion, payload: toJsonRecord(checked) };
}

/** The parsed payloads hold only JSON values (strings, numbers, booleans, arrays, objects). */
function toJsonRecord(value: object): NewEvent['payload'] {
  return z.record(z.string(), z.json()).parse(value);
}
