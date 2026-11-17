// SPDX-License-Identifier: MPL-2.0
import { createEventRegistry, defineEventType, InvalidInput, type NewEvent } from '@otheater/core';
import { z } from 'zod';
import { BACKUP_TRIGGERS } from './api.js';
import {
  DirectiveActivatedPayloadSchema,
  DirectiveCreatedPayloadSchema,
  DirectiveExpiredPayloadSchema,
  DirectiveExpiringPayloadSchema,
  DirectiveRevokedPayloadSchema,
  DirectiveSuspendedPayloadSchema,
  DirectiveValidityChangedPayloadSchema,
} from './directive-events.js';
import {
  PermissionAnsweredPayloadSchema,
  PermissionAskedPayloadSchema,
} from './permission-events.js';
import {
  IdeaAddedPayloadSchema,
  IdeaDeferredPayloadSchema,
  IdeaDiscardedPayloadSchema,
  IdeaDonePayloadSchema,
  IdeaGroupedPayloadSchema,
  IdeaPlayOpenedPayloadSchema,
  IdeaQueueHeldPayloadSchema,
  IdeaReturnedPayloadSchema,
} from './idea-events.js';
import {
  ScenarioAttachmentAddedPayloadSchema,
  ScenarioChatTransitionedPayloadSchema,
  ScenarioSystemMessagePayloadSchema,
  ScenarioCreatedPayloadSchema,
  ScenarioDirectorSleptPayloadSchema,
  ScenarioDirectorWokePayloadSchema,
} from './scenario-events.js';
import {
  AttemptCheckpointPayloadSchema,
  AttemptSubmitFailedPayloadSchema,
  AttemptSubmittedPayloadSchema,
  SessionClosedPayloadSchema,
  SessionCancelEscalatedPayloadSchema,
  SessionInterruptedPayloadSchema,
  SessionOpenedPayloadSchema,
  SessionPromptFinishedPayloadSchema,
  SessionResumedPayloadSchema,
  SessionUpdatePayloadSchema,
} from './session-events.js';
import { ToolCalledPayloadSchema, ToolFinishedPayloadSchema } from './tool-events.js';
import {
  DeliveryCompletedPayloadSchema,
  WorkspaceIntegratedPayloadSchema,
  WorkspaceIntegrationFailedPayloadSchema,
} from './workspace-events.js';

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

/**
 * [proposta] Fields of `daemon.recovered` (architecture 5.21, step 8 of the reconciliation): what
 * the start-up found and did, written once the plays were resumed. `pending` lists what still
 * needs the Producer.
 */
export const DaemonRecoveredPayloadSchema = z.strictObject({
  durationMs: z.int().min(0),
  /** Client processes of the dead daemon that were alive, matched by pid and start instant, and ended. */
  orphansKilled: z.int().min(0),
  /** Sessions that were `active` and are now `interrupted`. */
  sessionsInterrupted: z.int().min(0),
  /** Attempts that were in progress and are now parked as `interrupted`. */
  attemptsInterrupted: z.int().min(0),
  /** `wip(recovery)` commits made over what the worktrees held uncommitted. */
  wipCommits: z.int().min(0),
  /** Effects that had an intent and no end, and that the verifier settled. */
  effectsResolved: z.int().min(0),
  /** Plays whose machine was restored from the snapshot. */
  playsResumed: z.array(z.string().min(1)),
  /** Plays that could not be restored. */
  playsRefused: z.array(z.string().min(1)),
  pending: z.array(
    z.strictObject({
      kind: z.literal('effect'),
      /** Idempotency key of the effect nobody could settle. */
      key: z.string().min(1),
      effectType: z.string().min(1),
      playId: z.string().min(1).nullable(),
      reason: z.string(),
    }),
  ),
});

/**
 * The definitions of the 32 event types the daemon writes. This list is what the daemon hands to
 * the event registry at start-up; `DAEMON_EVENT_TYPES` below is derived from it.
 */
export const DAEMON_EVENT_DEFINITIONS = [
  defineEventType({
    type: 'daemon.started',
    schemaVersion: 1,
    payload: DaemonStartedPayloadSchema,
  }),
  defineEventType({
    type: 'daemon.stopped',
    schemaVersion: 1,
    payload: DaemonStoppedPayloadSchema,
  }),
  defineEventType({ type: 'daemon.backup', schemaVersion: 1, payload: DaemonBackupPayloadSchema }),
  defineEventType({
    type: 'daemon.recovered',
    schemaVersion: 1,
    payload: DaemonRecoveredPayloadSchema,
  }),
  defineEventType({
    type: 'session.opened',
    schemaVersion: 1,
    payload: SessionOpenedPayloadSchema,
  }),
  defineEventType({
    type: 'session.update',
    schemaVersion: 1,
    payload: SessionUpdatePayloadSchema,
  }),
  defineEventType({
    type: 'session.prompt_finished',
    schemaVersion: 1,
    payload: SessionPromptFinishedPayloadSchema,
  }),
  defineEventType({
    type: 'session.interrupted',
    schemaVersion: 1,
    payload: SessionInterruptedPayloadSchema,
  }),
  defineEventType({
    type: 'session.resumed',
    schemaVersion: 1,
    payload: SessionResumedPayloadSchema,
  }),
  defineEventType({
    type: 'session.cancel_escalated',
    schemaVersion: 1,
    payload: SessionCancelEscalatedPayloadSchema,
  }),
  defineEventType({
    type: 'session.closed',
    schemaVersion: 1,
    payload: SessionClosedPayloadSchema,
  }),
  defineEventType({
    type: 'permission.asked',
    schemaVersion: 1,
    payload: PermissionAskedPayloadSchema,
  }),
  defineEventType({
    type: 'permission.answered',
    schemaVersion: 1,
    payload: PermissionAnsweredPayloadSchema,
  }),
  defineEventType({
    type: 'attempt.checkpoint',
    schemaVersion: 1,
    payload: AttemptCheckpointPayloadSchema,
  }),
  defineEventType({
    type: 'attempt.submitted',
    schemaVersion: 1,
    payload: AttemptSubmittedPayloadSchema,
  }),
  defineEventType({
    type: 'attempt.submit_failed',
    schemaVersion: 1,
    payload: AttemptSubmitFailedPayloadSchema,
  }),
  defineEventType({
    type: 'tool.called',
    schemaVersion: 1,
    payload: ToolCalledPayloadSchema,
  }),
  defineEventType({
    type: 'tool.finished',
    schemaVersion: 1,
    payload: ToolFinishedPayloadSchema,
  }),
  defineEventType({
    type: 'workspace.integrated',
    schemaVersion: 1,
    payload: WorkspaceIntegratedPayloadSchema,
  }),
  defineEventType({
    type: 'workspace.integration_failed',
    schemaVersion: 1,
    payload: WorkspaceIntegrationFailedPayloadSchema,
  }),
  defineEventType({
    type: 'delivery.completed',
    schemaVersion: 1,
    payload: DeliveryCompletedPayloadSchema,
  }),
  defineEventType({
    type: 'directive.created',
    schemaVersion: 1,
    payload: DirectiveCreatedPayloadSchema,
  }),
  defineEventType({
    type: 'directive.activated',
    schemaVersion: 1,
    payload: DirectiveActivatedPayloadSchema,
  }),
  defineEventType({
    type: 'directive.validity_changed',
    schemaVersion: 1,
    payload: DirectiveValidityChangedPayloadSchema,
  }),
  defineEventType({
    type: 'directive.expiring',
    schemaVersion: 1,
    payload: DirectiveExpiringPayloadSchema,
  }),
  defineEventType({
    type: 'directive.expired',
    schemaVersion: 1,
    payload: DirectiveExpiredPayloadSchema,
  }),
  defineEventType({
    type: 'directive.revoked',
    schemaVersion: 1,
    payload: DirectiveRevokedPayloadSchema,
  }),
  defineEventType({
    type: 'directive.suspended',
    schemaVersion: 1,
    payload: DirectiveSuspendedPayloadSchema,
  }),
  defineEventType({ type: 'idea.added', schemaVersion: 1, payload: IdeaAddedPayloadSchema }),
  defineEventType({ type: 'idea.grouped', schemaVersion: 1, payload: IdeaGroupedPayloadSchema }),
  defineEventType({
    type: 'idea.play_opened',
    schemaVersion: 1,
    payload: IdeaPlayOpenedPayloadSchema,
  }),
  defineEventType({
    type: 'idea.discarded',
    schemaVersion: 1,
    payload: IdeaDiscardedPayloadSchema,
  }),
  defineEventType({ type: 'idea.deferred', schemaVersion: 1, payload: IdeaDeferredPayloadSchema }),
  defineEventType({ type: 'idea.done', schemaVersion: 1, payload: IdeaDonePayloadSchema }),
  defineEventType({ type: 'idea.returned', schemaVersion: 1, payload: IdeaReturnedPayloadSchema }),
  defineEventType({
    type: 'idea.queue_held',
    schemaVersion: 1,
    payload: IdeaQueueHeldPayloadSchema,
  }),
  defineEventType({
    type: 'scenario.created',
    schemaVersion: 1,
    payload: ScenarioCreatedPayloadSchema,
  }),
  defineEventType({
    type: 'scenario.attachment_added',
    schemaVersion: 1,
    payload: ScenarioAttachmentAddedPayloadSchema,
  }),
  defineEventType({
    type: 'scenario.director_slept',
    schemaVersion: 1,
    payload: ScenarioDirectorSleptPayloadSchema,
  }),
  defineEventType({
    type: 'scenario.director_woke',
    schemaVersion: 1,
    payload: ScenarioDirectorWokePayloadSchema,
  }),
  defineEventType({
    type: 'scenario.chat_transitioned',
    schemaVersion: 1,
    payload: ScenarioChatTransitionedPayloadSchema,
  }),
  defineEventType({
    type: 'scenario.system_message',
    schemaVersion: 1,
    payload: ScenarioSystemMessagePayloadSchema,
  }),
] as const;

type DaemonEventDefinition = (typeof DAEMON_EVENT_DEFINITIONS)[number];

/** Registry of the daemon's own event types, derived from {@link DAEMON_EVENT_DEFINITIONS}. */
export const DAEMON_EVENT_TYPES = Object.fromEntries(
  DAEMON_EVENT_DEFINITIONS.map((definition) => [
    definition.type,
    { schemaVersion: definition.schemaVersion, payload: definition.payload },
  ]),
) as {
  readonly [D in DaemonEventDefinition as D['type']]: {
    readonly schemaVersion: number;
    readonly payload: D['payload'];
  };
};

/** The event registry of the daemon's own types. */
const DAEMON_EVENT_REGISTRY = createEventRegistry(DAEMON_EVENT_DEFINITIONS);

export type DaemonEventType = keyof typeof DAEMON_EVENT_TYPES;

export type DaemonEventPayloads = {
  [T in DaemonEventType]: z.infer<(typeof DAEMON_EVENT_TYPES)[T]['payload']>;
};

export type DaemonStartedPayload = DaemonEventPayloads['daemon.started'];
export type DaemonStoppedPayload = DaemonEventPayloads['daemon.stopped'];
export type DaemonBackupPayload = DaemonEventPayloads['daemon.backup'];
export type DaemonRecoveredPayload = DaemonEventPayloads['daemon.recovered'];
export type SessionOpenedPayload = DaemonEventPayloads['session.opened'];
export type SessionUpdatePayload = DaemonEventPayloads['session.update'];
export type SessionPromptFinishedPayload = DaemonEventPayloads['session.prompt_finished'];
export type SessionInterruptedPayload = DaemonEventPayloads['session.interrupted'];
export type SessionResumedPayload = DaemonEventPayloads['session.resumed'];
export type SessionCancelEscalatedPayload = DaemonEventPayloads['session.cancel_escalated'];
export type SessionClosedPayload = DaemonEventPayloads['session.closed'];
export type PermissionAskedPayload = DaemonEventPayloads['permission.asked'];
export type PermissionAnsweredPayload = DaemonEventPayloads['permission.answered'];
export type AttemptCheckpointPayload = DaemonEventPayloads['attempt.checkpoint'];
export type AttemptSubmittedPayload = DaemonEventPayloads['attempt.submitted'];
export type AttemptSubmitFailedPayload = DaemonEventPayloads['attempt.submit_failed'];
export type ToolCalledPayload = DaemonEventPayloads['tool.called'];
export type ToolFinishedPayload = DaemonEventPayloads['tool.finished'];
export type WorkspaceIntegratedPayload = DaemonEventPayloads['workspace.integrated'];
export type WorkspaceIntegrationFailedPayload = DaemonEventPayloads['workspace.integration_failed'];
export type DeliveryCompletedPayload = DaemonEventPayloads['delivery.completed'];
export type DirectiveCreatedPayload = DaemonEventPayloads['directive.created'];
export type DirectiveActivatedPayload = DaemonEventPayloads['directive.activated'];
export type DirectiveValidityChangedPayload = DaemonEventPayloads['directive.validity_changed'];
export type DirectiveExpiringPayload = DaemonEventPayloads['directive.expiring'];
export type DirectiveExpiredPayload = DaemonEventPayloads['directive.expired'];
export type DirectiveRevokedPayload = DaemonEventPayloads['directive.revoked'];
export type DirectiveSuspendedPayload = DaemonEventPayloads['directive.suspended'];
export type IdeaAddedPayload = DaemonEventPayloads['idea.added'];
export type IdeaGroupedPayload = DaemonEventPayloads['idea.grouped'];
export type IdeaPlayOpenedPayload = DaemonEventPayloads['idea.play_opened'];
export type IdeaDiscardedPayload = DaemonEventPayloads['idea.discarded'];
export type IdeaDeferredPayload = DaemonEventPayloads['idea.deferred'];
export type IdeaDonePayload = DaemonEventPayloads['idea.done'];
export type IdeaReturnedPayload = DaemonEventPayloads['idea.returned'];
export type IdeaQueueHeldPayload = DaemonEventPayloads['idea.queue_held'];
export type ScenarioCreatedPayload = DaemonEventPayloads['scenario.created'];
export type ScenarioAttachmentAddedPayload = DaemonEventPayloads['scenario.attachment_added'];
export type ScenarioDirectorSleptPayload = DaemonEventPayloads['scenario.director_slept'];
export type ScenarioDirectorWokePayload = DaemonEventPayloads['scenario.director_woke'];
export type ScenarioChatTransitionedPayload = DaemonEventPayloads['scenario.chat_transitioned'];
export type ScenarioSystemMessagePayload = DaemonEventPayloads['scenario.system_message'];

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
  return DAEMON_EVENT_REGISTRY.parseEvent(
    type,
    schemaVersion,
    payload,
  ) as DaemonEventPayloads[DaemonEventType];
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
