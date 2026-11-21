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
  BudgetExceededPayloadSchema,
  BudgetRestoredPayloadSchema,
  BudgetUnknownCostPayloadSchema,
  BudgetWarningPayloadSchema,
  QuotaExhaustedPayloadSchema,
  QuotaNearLimitPayloadSchema,
  QuotaProbeFailedPayloadSchema,
  QuotaRestoredPayloadSchema,
  QuotaSignalDroppedPayloadSchema,
  QuotaUpdatedPayloadSchema,
} from './quota-events.js';
import {
  DemandResumedPayloadSchema,
  DemandWaitingPayloadSchema,
  ExecutorChangedPayloadSchema,
  ExecutorSelectedPayloadSchema,
  ScenarioDirectorResumedPayloadSchema,
  ScenarioDirectorWaitingPayloadSchema,
} from './selection-events.js';
import {
  ApiClientRejectedPayloadSchema,
  ApiStartedPayloadSchema,
  ApiStreamLaggedPayloadSchema,
} from './api-events.js';
import {
  ConfigEditedPayloadSchema,
  ScenarioDecisionAnsweredPayloadSchema,
} from './api-command-events.js';
import { LayoutAdjustedPayloadSchema, LayoutChangedPayloadSchema } from './layout-events.js';
import {
  SetupBackPayloadSchema,
  SetupCancelledPayloadSchema,
  SetupConfirmedPayloadSchema,
  SetupStartedPayloadSchema,
  SetupStepPayloadSchema,
} from './setup-events.js';
import {
  ApiChatClosedPayloadSchema,
  ApiChatMessageDroppedPayloadSchema,
  ChatAskClosedPayloadSchema,
  ChatAskPayloadSchema,
  ChatDirectorReplyPayloadSchema,
  ChatDirectorSilentPayloadSchema,
  PromptQueuedPayloadSchema,
} from './chat-events.js';
import {
  ShellCommandFinishedPayloadSchema,
  ShellCommandStartedPayloadSchema,
} from './shell-events.js';
import {
  DecisionAnsweredPayloadSchema,
  DecisionCreatedPayloadSchema,
  DemandTransitionedPayloadSchema,
  ScenarioArchivedPayloadSchema,
} from './record-events.js';
import {
  DaemonNoticePayloadSchema,
  RecoveryNoticePayloadSchema,
  ScenarioNoticePayloadSchema,
} from './notice-events.js';
import { UsageNoticePayloadSchema, UsageRecordedPayloadSchema } from './usage-events.js';
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
  ProfileAddedPayloadSchema,
  ProfileDrainedPayloadSchema,
  ProfileDrainingPayloadSchema,
  ProfileNoticeAcceptedPayloadSchema,
  ProfileRemovedPayloadSchema,
  ProfileExecEndedPayloadSchema,
  ProfileExecStartedPayloadSchema,
  ProfileLoginCompletedPayloadSchema,
  ProfileLoginFailedPayloadSchema,
  ProfileLoginStartedPayloadSchema,
  ProfileShimsRcChangedPayloadSchema,
  ProfileShimsSyncedPayloadSchema,
  ProfileWarningPayloadSchema,
} from './profile-events.js';
import {
  ScenarioAttachmentAddedPayloadSchema,
  ScenarioChatTransitionedPayloadSchema,
  ScenarioSystemMessagePayloadSchema,
  ScenarioCreatedPayloadSchema,
  ScenarioDirectorSleptPayloadSchema,
  ScenarioDirectorWokePayloadSchema,
  PlayNoticePayloadSchema,
} from './scenario-events.js';
import {
  AttemptAbortedPayloadSchema,
  AttemptCancelledPayloadSchema,
  AttemptCheckpointFailedPayloadSchema,
  AttemptCheckpointPayloadSchema,
  AttemptPausedPayloadSchema,
  AttemptResetWaitEndedPayloadSchema,
  AttemptResetWaitStartedPayloadSchema,
  AttemptResumedPayloadSchema,
  AttemptSubmitFailedPayloadSchema,
  AttemptSubmittedPayloadSchema,
  SessionClosedPayloadSchema,
  SessionCancelEscalatedPayloadSchema,
  SessionHandoffFailedPayloadSchema,
  SessionHandoffPayloadSchema,
  SessionInterruptedPayloadSchema,
  SessionOpenedPayloadSchema,
  SessionProcessesLeftPayloadSchema,
  SessionPromptFinishedPayloadSchema,
  SessionResumedPayloadSchema,
  SessionTurnTimeoutPayloadSchema,
  SessionUpdatePayloadSchema,
} from './session-events.js';
import {
  BrowserActionPayloadSchema,
  BrowserApprovalPayloadSchema,
  BrowserRefusedPayloadSchema,
} from './browser-events.js';
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
 * The definitions of the 36 event types the daemon writes. This list is what the daemon hands to
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
    type: 'session.handoff',
    schemaVersion: 1,
    payload: SessionHandoffPayloadSchema,
  }),
  defineEventType({
    type: 'session.handoff_failed',
    schemaVersion: 1,
    payload: SessionHandoffFailedPayloadSchema,
  }),
  defineEventType({
    type: 'attempt.reset_wait_started',
    schemaVersion: 1,
    payload: AttemptResetWaitStartedPayloadSchema,
  }),
  defineEventType({
    type: 'attempt.reset_wait_ended',
    schemaVersion: 1,
    payload: AttemptResetWaitEndedPayloadSchema,
  }),
  defineEventType({
    type: 'session.cancel_escalated',
    schemaVersion: 1,
    payload: SessionCancelEscalatedPayloadSchema,
  }),
  defineEventType({
    type: 'session.processes_left',
    schemaVersion: 1,
    payload: SessionProcessesLeftPayloadSchema,
  }),
  defineEventType({
    type: 'session.turn_timeout',
    schemaVersion: 1,
    payload: SessionTurnTimeoutPayloadSchema,
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
    type: 'attempt.checkpoint_failed',
    schemaVersion: 1,
    payload: AttemptCheckpointFailedPayloadSchema,
  }),
  defineEventType({
    type: 'attempt.aborted',
    schemaVersion: 1,
    payload: AttemptAbortedPayloadSchema,
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
    type: 'attempt.paused',
    schemaVersion: 1,
    payload: AttemptPausedPayloadSchema,
  }),
  defineEventType({
    type: 'attempt.resumed',
    schemaVersion: 1,
    payload: AttemptResumedPayloadSchema,
  }),
  defineEventType({
    type: 'attempt.cancelled',
    schemaVersion: 1,
    payload: AttemptCancelledPayloadSchema,
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
    type: 'browser.action',
    schemaVersion: 1,
    payload: BrowserActionPayloadSchema,
  }),
  defineEventType({
    type: 'browser.refused',
    schemaVersion: 1,
    payload: BrowserRefusedPayloadSchema,
  }),
  defineEventType({
    type: 'browser.approval',
    schemaVersion: 1,
    payload: BrowserApprovalPayloadSchema,
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
  defineEventType({ type: 'profile.added', schemaVersion: 1, payload: ProfileAddedPayloadSchema }),
  defineEventType({
    type: 'profile.notice_accepted',
    schemaVersion: 1,
    payload: ProfileNoticeAcceptedPayloadSchema,
  }),
  defineEventType({
    type: 'profile.draining',
    schemaVersion: 1,
    payload: ProfileDrainingPayloadSchema,
  }),
  defineEventType({
    type: 'profile.drained',
    schemaVersion: 1,
    payload: ProfileDrainedPayloadSchema,
  }),
  defineEventType({
    type: 'profile.removed',
    schemaVersion: 1,
    payload: ProfileRemovedPayloadSchema,
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
  defineEventType({ type: 'quota.updated', schemaVersion: 1, payload: QuotaUpdatedPayloadSchema }),
  defineEventType({
    type: 'quota.near_limit',
    schemaVersion: 1,
    payload: QuotaNearLimitPayloadSchema,
  }),
  defineEventType({
    type: 'quota.exhausted',
    schemaVersion: 1,
    payload: QuotaExhaustedPayloadSchema,
  }),
  defineEventType({
    type: 'quota.restored',
    schemaVersion: 1,
    payload: QuotaRestoredPayloadSchema,
  }),
  defineEventType({
    type: 'budget.restored',
    schemaVersion: 1,
    payload: BudgetRestoredPayloadSchema,
  }),
  defineEventType({
    type: 'budget.warning',
    schemaVersion: 1,
    payload: BudgetWarningPayloadSchema,
  }),
  defineEventType({
    type: 'budget.exceeded',
    schemaVersion: 1,
    payload: BudgetExceededPayloadSchema,
  }),
  defineEventType({
    type: 'budget.unknown_cost',
    schemaVersion: 1,
    payload: BudgetUnknownCostPayloadSchema,
  }),
  defineEventType({
    type: 'usage.recorded',
    schemaVersion: 1,
    payload: UsageRecordedPayloadSchema,
  }),
  defineEventType({
    type: 'executor.selected',
    schemaVersion: 2,
    payload: ExecutorSelectedPayloadSchema,
  }),
  defineEventType({
    type: 'scenario.director_waiting',
    schemaVersion: 1,
    payload: ScenarioDirectorWaitingPayloadSchema,
  }),
  defineEventType({
    type: 'scenario.director_resumed',
    schemaVersion: 1,
    payload: ScenarioDirectorResumedPayloadSchema,
  }),
  defineEventType({
    type: 'demand.waiting',
    schemaVersion: 1,
    payload: DemandWaitingPayloadSchema,
  }),
  defineEventType({
    type: 'demand.resumed',
    schemaVersion: 1,
    payload: DemandResumedPayloadSchema,
  }),
  defineEventType({
    type: 'play.notice',
    schemaVersion: 1,
    payload: PlayNoticePayloadSchema,
  }),
  defineEventType({
    type: 'quota.probe_failed',
    schemaVersion: 1,
    payload: QuotaProbeFailedPayloadSchema,
  }),
  defineEventType({
    type: 'quota.signal_dropped',
    schemaVersion: 1,
    payload: QuotaSignalDroppedPayloadSchema,
  }),
  defineEventType({
    type: 'usage.notice',
    schemaVersion: 1,
    payload: UsageNoticePayloadSchema,
  }),
  defineEventType({
    type: 'profile.warning',
    schemaVersion: 1,
    payload: ProfileWarningPayloadSchema,
  }),
  defineEventType({
    type: 'profile.exec.started',
    schemaVersion: 1,
    payload: ProfileExecStartedPayloadSchema,
  }),
  defineEventType({
    type: 'profile.exec.ended',
    schemaVersion: 1,
    payload: ProfileExecEndedPayloadSchema,
  }),
  defineEventType({
    type: 'profile.shims.synced',
    schemaVersion: 1,
    payload: ProfileShimsSyncedPayloadSchema,
  }),
  defineEventType({
    type: 'profile.shims.rc_changed',
    schemaVersion: 1,
    payload: ProfileShimsRcChangedPayloadSchema,
  }),
  defineEventType({
    type: 'profile.login.started',
    schemaVersion: 1,
    payload: ProfileLoginStartedPayloadSchema,
  }),
  defineEventType({
    type: 'profile.login.completed',
    schemaVersion: 1,
    payload: ProfileLoginCompletedPayloadSchema,
  }),
  defineEventType({
    type: 'profile.login.failed',
    schemaVersion: 1,
    payload: ProfileLoginFailedPayloadSchema,
  }),
  defineEventType({
    type: 'executor.changed',
    schemaVersion: 1,
    payload: ExecutorChangedPayloadSchema,
  }),
  defineEventType({
    type: 'daemon.notice',
    schemaVersion: 1,
    payload: DaemonNoticePayloadSchema,
  }),
  defineEventType({
    type: 'recovery.notice',
    schemaVersion: 1,
    payload: RecoveryNoticePayloadSchema,
  }),
  defineEventType({
    type: 'scenario.notice',
    schemaVersion: 1,
    payload: ScenarioNoticePayloadSchema,
  }),
  defineEventType({
    type: 'api.started',
    schemaVersion: 1,
    payload: ApiStartedPayloadSchema,
  }),
  defineEventType({
    type: 'api.client_rejected',
    schemaVersion: 1,
    payload: ApiClientRejectedPayloadSchema,
  }),
  defineEventType({
    type: 'api.stream_lagged',
    schemaVersion: 1,
    payload: ApiStreamLaggedPayloadSchema,
  }),
  defineEventType({
    type: 'scenario.decision_answered',
    schemaVersion: 1,
    payload: ScenarioDecisionAnsweredPayloadSchema,
  }),
  defineEventType({
    type: 'config.edited',
    schemaVersion: 1,
    payload: ConfigEditedPayloadSchema,
  }),
  defineEventType({
    type: 'prompt.queued',
    schemaVersion: 1,
    payload: PromptQueuedPayloadSchema,
  }),
  defineEventType({
    type: 'chat.director_reply',
    schemaVersion: 1,
    payload: ChatDirectorReplyPayloadSchema,
  }),
  defineEventType({
    type: 'chat.director_silent',
    schemaVersion: 1,
    payload: ChatDirectorSilentPayloadSchema,
  }),
  defineEventType({
    type: 'chat.ask',
    schemaVersion: 1,
    payload: ChatAskPayloadSchema,
  }),
  defineEventType({
    type: 'chat.ask_closed',
    schemaVersion: 1,
    payload: ChatAskClosedPayloadSchema,
  }),
  defineEventType({
    type: 'chat.shell_command.started',
    schemaVersion: 1,
    payload: ShellCommandStartedPayloadSchema,
  }),
  defineEventType({
    type: 'chat.shell_command.finished',
    schemaVersion: 1,
    payload: ShellCommandFinishedPayloadSchema,
  }),
  defineEventType({
    type: 'api.chat_closed',
    schemaVersion: 1,
    payload: ApiChatClosedPayloadSchema,
  }),
  defineEventType({
    type: 'api.chat_message_dropped',
    schemaVersion: 1,
    payload: ApiChatMessageDroppedPayloadSchema,
  }),
  defineEventType({
    type: 'layout.adjusted',
    schemaVersion: 1,
    payload: LayoutAdjustedPayloadSchema,
  }),
  defineEventType({
    type: 'layout.changed',
    schemaVersion: 1,
    payload: LayoutChangedPayloadSchema,
  }),
  defineEventType({ type: 'setup.started', schemaVersion: 1, payload: SetupStartedPayloadSchema }),
  defineEventType({ type: 'setup.step', schemaVersion: 1, payload: SetupStepPayloadSchema }),
  defineEventType({ type: 'setup.back', schemaVersion: 1, payload: SetupBackPayloadSchema }),
  defineEventType({
    type: 'setup.confirmed',
    schemaVersion: 1,
    payload: SetupConfirmedPayloadSchema,
  }),
  defineEventType({
    type: 'setup.cancelled',
    schemaVersion: 1,
    payload: SetupCancelledPayloadSchema,
  }),
  defineEventType({
    type: 'decision.created',
    schemaVersion: 1,
    payload: DecisionCreatedPayloadSchema,
  }),
  defineEventType({
    type: 'decision.answered',
    schemaVersion: 1,
    payload: DecisionAnsweredPayloadSchema,
  }),
  defineEventType({
    type: 'scenario.archived',
    schemaVersion: 1,
    payload: ScenarioArchivedPayloadSchema,
  }),
  defineEventType({
    type: 'demand.transitioned',
    schemaVersion: 1,
    payload: DemandTransitionedPayloadSchema,
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
export type SessionHandoffPayload = DaemonEventPayloads['session.handoff'];
export type SessionHandoffFailedPayload = DaemonEventPayloads['session.handoff_failed'];
export type SessionProcessesLeftPayload = DaemonEventPayloads['session.processes_left'];
export type AttemptCheckpointFailedPayload = DaemonEventPayloads['attempt.checkpoint_failed'];
export type AttemptAbortedPayload = DaemonEventPayloads['attempt.aborted'];
export type AttemptResetWaitStartedPayload = DaemonEventPayloads['attempt.reset_wait_started'];
export type AttemptResetWaitEndedPayload = DaemonEventPayloads['attempt.reset_wait_ended'];
export type SessionCancelEscalatedPayload = DaemonEventPayloads['session.cancel_escalated'];
export type SessionTurnTimeoutPayload = DaemonEventPayloads['session.turn_timeout'];
export type SessionClosedPayload = DaemonEventPayloads['session.closed'];
export type PermissionAskedPayload = DaemonEventPayloads['permission.asked'];
export type PermissionAnsweredPayload = DaemonEventPayloads['permission.answered'];
export type AttemptCheckpointPayload = DaemonEventPayloads['attempt.checkpoint'];
export type AttemptSubmittedPayload = DaemonEventPayloads['attempt.submitted'];
export type AttemptSubmitFailedPayload = DaemonEventPayloads['attempt.submit_failed'];
export type AttemptPausedPayload = DaemonEventPayloads['attempt.paused'];
export type AttemptResumedPayload = DaemonEventPayloads['attempt.resumed'];
export type AttemptCancelledPayload = DaemonEventPayloads['attempt.cancelled'];
export type ToolCalledPayload = DaemonEventPayloads['tool.called'];
export type ToolFinishedPayload = DaemonEventPayloads['tool.finished'];
export type BrowserActionPayload = DaemonEventPayloads['browser.action'];
export type BrowserRefusedPayload = DaemonEventPayloads['browser.refused'];
export type BrowserApprovalPayload = DaemonEventPayloads['browser.approval'];
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
export type ProfileAddedPayload = DaemonEventPayloads['profile.added'];
export type ProfileNoticeAcceptedPayload = DaemonEventPayloads['profile.notice_accepted'];
export type ProfileDrainingPayload = DaemonEventPayloads['profile.draining'];
export type ProfileDrainedPayload = DaemonEventPayloads['profile.drained'];
export type ProfileRemovedPayload = DaemonEventPayloads['profile.removed'];
export type ScenarioCreatedPayload = DaemonEventPayloads['scenario.created'];
export type ScenarioAttachmentAddedPayload = DaemonEventPayloads['scenario.attachment_added'];
export type ScenarioDirectorSleptPayload = DaemonEventPayloads['scenario.director_slept'];
export type ScenarioDirectorWokePayload = DaemonEventPayloads['scenario.director_woke'];
export type ScenarioChatTransitionedPayload = DaemonEventPayloads['scenario.chat_transitioned'];
export type ScenarioSystemMessagePayload = DaemonEventPayloads['scenario.system_message'];
export type ScenarioRecoveryNotice = Extract<ScenarioSystemMessagePayload, { kind: 'recovery' }>;
export type ScenarioHandoffNotice = Extract<ScenarioSystemMessagePayload, { kind: 'handoff' }>;
export type ScenarioResetWaitNotice = Extract<ScenarioSystemMessagePayload, { kind: 'reset_wait' }>;
export type ScenarioDirectorFailoverNotice = Extract<
  ScenarioSystemMessagePayload,
  { kind: 'director_failover' }
>;
export type ScenarioSelectionWaitNotice = Extract<
  ScenarioSystemMessagePayload,
  { kind: 'selection_wait' }
>;
export type QuotaUpdatedPayload = DaemonEventPayloads['quota.updated'];
export type QuotaNearLimitPayload = DaemonEventPayloads['quota.near_limit'];
export type QuotaExhaustedPayload = DaemonEventPayloads['quota.exhausted'];
export type QuotaRestoredPayload = DaemonEventPayloads['quota.restored'];
export type BudgetRestoredPayload = DaemonEventPayloads['budget.restored'];
export type BudgetWarningPayload = DaemonEventPayloads['budget.warning'];
export type BudgetExceededPayload = DaemonEventPayloads['budget.exceeded'];
export type BudgetUnknownCostPayload = DaemonEventPayloads['budget.unknown_cost'];
export type UsageRecordedPayload = DaemonEventPayloads['usage.recorded'];
export type ExecutorSelectedPayload = DaemonEventPayloads['executor.selected'];
export type ScenarioDirectorWaitingPayload = DaemonEventPayloads['scenario.director_waiting'];
export type ScenarioDirectorResumedPayload = DaemonEventPayloads['scenario.director_resumed'];
export type DemandWaitingPayload = DaemonEventPayloads['demand.waiting'];
export type DemandResumedPayload = DaemonEventPayloads['demand.resumed'];
export type PlayNoticePayload = DaemonEventPayloads['play.notice'];
export type QuotaProbeFailedPayload = DaemonEventPayloads['quota.probe_failed'];
export type QuotaSignalDroppedPayload = DaemonEventPayloads['quota.signal_dropped'];
export type UsageNoticePayload = DaemonEventPayloads['usage.notice'];
export type ProfileWarningPayload = DaemonEventPayloads['profile.warning'];
export type ProfileExecStartedPayload = DaemonEventPayloads['profile.exec.started'];
export type ProfileExecEndedPayload = DaemonEventPayloads['profile.exec.ended'];
export type ProfileShimsSyncedPayload = DaemonEventPayloads['profile.shims.synced'];
export type ProfileShimsRcChangedPayload = DaemonEventPayloads['profile.shims.rc_changed'];
export type ProfileLoginStartedPayload = DaemonEventPayloads['profile.login.started'];
export type ProfileLoginCompletedPayload = DaemonEventPayloads['profile.login.completed'];
export type ProfileLoginFailedPayload = DaemonEventPayloads['profile.login.failed'];
export type ExecutorChangedPayload = DaemonEventPayloads['executor.changed'];
export type DaemonNoticePayload = DaemonEventPayloads['daemon.notice'];
export type RecoveryNoticePayload = DaemonEventPayloads['recovery.notice'];
export type ScenarioNoticePayload = DaemonEventPayloads['scenario.notice'];
export type ApiStartedPayload = DaemonEventPayloads['api.started'];
export type ApiClientRejectedPayload = DaemonEventPayloads['api.client_rejected'];
export type ApiStreamLaggedPayload = DaemonEventPayloads['api.stream_lagged'];
export type ScenarioDecisionAnsweredPayload = DaemonEventPayloads['scenario.decision_answered'];
export type ConfigEditedPayload = DaemonEventPayloads['config.edited'];
export type PromptQueuedPayload = DaemonEventPayloads['prompt.queued'];
export type ChatDirectorReplyPayload = DaemonEventPayloads['chat.director_reply'];
export type ChatDirectorSilentPayload = DaemonEventPayloads['chat.director_silent'];
export type ChatAskPayload = DaemonEventPayloads['chat.ask'];
export type ChatAskClosedPayload = DaemonEventPayloads['chat.ask_closed'];
export type ShellCommandStartedPayload = DaemonEventPayloads['chat.shell_command.started'];
export type ShellCommandFinishedPayload = DaemonEventPayloads['chat.shell_command.finished'];
export type ApiChatClosedPayload = DaemonEventPayloads['api.chat_closed'];
export type ApiChatMessageDroppedPayload = DaemonEventPayloads['api.chat_message_dropped'];
export type LayoutAdjustedPayload = DaemonEventPayloads['layout.adjusted'];
export type LayoutChangedPayload = DaemonEventPayloads['layout.changed'];
export type SetupStartedPayload = DaemonEventPayloads['setup.started'];
export type SetupStepPayload = DaemonEventPayloads['setup.step'];
export type SetupBackPayload = DaemonEventPayloads['setup.back'];
export type SetupConfirmedPayload = DaemonEventPayloads['setup.confirmed'];
export type SetupCancelledPayload = DaemonEventPayloads['setup.cancelled'];
export type DecisionCreatedPayload = DaemonEventPayloads['decision.created'];
export type DecisionAnsweredPayload = DaemonEventPayloads['decision.answered'];
export type ScenarioArchivedPayload = DaemonEventPayloads['scenario.archived'];
export type DemandTransitionedPayload = DaemonEventPayloads['demand.transitioned'];

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
