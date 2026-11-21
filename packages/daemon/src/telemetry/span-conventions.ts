// SPDX-License-Identifier: MPL-2.0

/**
 * The names and conventions of the spans of the daemon (Phase 8, P4; architecture 5.11), all in
 * this one file. The GenAI semantic conventions for agents are still in "Development" upstream, so
 * when they move, this table is the only place that changes. [proposta]
 *
 * The tree of a play: `otheater.play` > `otheater.stage` > `invoke_agent` (the attempt) >
 * `invoke_agent` (the session) > `execute_tool`; `otheater.wait` hangs from whatever waited.
 */

/** OTLP `SpanKind` numbers the spans use. */
export const SPAN_KIND = { internal: 1, client: 3 } as const;

/** The GenAI operations (`gen_ai.operation.name`). */
export const GEN_AI_OPERATION = {
  invokeAgent: 'invoke_agent',
  executeTool: 'execute_tool',
} as const;

/**
 * The names of the spans. The GenAI ones are `<operation> <subject>` (the agent name is the role,
 * the tool name is the tool), and drop the subject when there is none.
 */
export const SPAN_NAME = {
  play: 'otheater.play',
  stage: 'otheater.stage',
  wait: 'otheater.wait',
  invokeAgent: (agentName: string | undefined): string =>
    agentName === undefined
      ? GEN_AI_OPERATION.invokeAgent
      : `${GEN_AI_OPERATION.invokeAgent} ${agentName}`,
  executeTool: (toolName: string | undefined): string =>
    toolName === undefined
      ? GEN_AI_OPERATION.executeTool
      : `${GEN_AI_OPERATION.executeTool} ${toolName}`,
} as const;

/** Attribute keys of the GenAI conventions. */
export const GEN_AI = {
  operationName: 'gen_ai.operation.name',
  agentName: 'gen_ai.agent.name',
  agentId: 'gen_ai.agent.id',
  requestModel: 'gen_ai.request.model',
  providerName: 'gen_ai.provider.name',
  toolName: 'gen_ai.tool.name',
  toolCallId: 'gen_ai.tool.call.id',
  conversationId: 'gen_ai.conversation.id',
} as const;

/**
 * Attribute keys of the OTheater. The correlation ids are also resource attributes of what the
 * clients export (P2, P3), so a span of the daemon and a span of a client of the same attempt read
 * the same.
 */
export const OT = {
  scenarioId: 'otheater.scenario_id',
  playId: 'otheater.play_id',
  stageId: 'otheater.stage_id',
  attemptId: 'otheater.attempt_id',
  sessionId: 'otheater.session_id',
  demandId: 'otheater.demand_id',
  profile: 'otheater.profile',
  client: 'otheater.client',
  role: 'otheater.role',
  traceId: 'otheater.trace_id',
  /**
   * What the client had before the receiver put its span under the daemon's tree (Phase 9, P1): the
   * trace id it used, and the parent span id it had, when it had one.
   */
  clientTraceId: 'otheater.client.trace_id',
  clientParentSpanId: 'otheater.client.parent_span_id',
  /** The state of the play machine a stage is a visit of. */
  stage: 'otheater.stage',
  stageEvent: 'otheater.stage.event',
  stageReason: 'otheater.stage.reason',
  playFinalState: 'otheater.play.final_state',
  playFlow: 'otheater.play.flow',
  /** How a span the play ended with its children still open was closed. */
  closedBy: 'otheater.closed_by',
  sessionCloseReason: 'otheater.session.close_reason',
  sessionVia: 'otheater.session.via',
  sessionTurns: 'otheater.session.turns',
  sessionStopReason: 'otheater.session.stop_reason',
  attemptEnd: 'otheater.attempt.end',
  toolOutcome: 'otheater.tool.outcome',
  toolHeavy: 'otheater.tool.heavy',
  toolDurationMs: 'otheater.tool.duration_ms',
  toolQueuedMs: 'otheater.tool.queued_ms',
  toolExitCode: 'otheater.tool.exit_code',
  toolErrorCode: 'otheater.tool.error_code',
  /** What was waited for: one of {@link WAIT_KIND}. */
  waitKind: 'otheater.wait.kind',
  /** Why: the cause, in the words of the event or the semaphore that said it. */
  waitReason: 'otheater.wait.reason',
  waitOutcome: 'otheater.wait.outcome',
  waitMs: 'otheater.wait.ms',
  waitResetsAt: 'otheater.wait.resets_at',
  /** Always `log`: every wait span is made from events (`direct` went out with P15). */
  waitOrigin: 'otheater.wait.origin',
  waitSource: 'otheater.wait.source',
  waitPriority: 'otheater.wait.priority',
} as const;

/** What a `otheater.wait` span waited for (`otheater.wait.kind`). */
export const WAIT_KIND = {
  /** A prompt in the `prompt_queue`, until the dispatcher handed it to the Director. */
  promptQueue: 'prompt_queue',
  /** A session in the queue of the pool (slots, RAM, quota, a local instance). */
  poolAdmission: 'pool_admission',
  /** A tool call in the heavy-tools semaphore (`tools.heavy_concurrency`). */
  toolSemaphore: 'tool_semaphore',
  /** The attempt waits for the quota or the spending cap to come back. */
  quota: 'quota',
  /** A demand waits for an Executor that fits (the selector set the candidates aside). */
  executorSelection: 'executor_selection',
} as const;
export type WaitKind = (typeof WAIT_KIND)[keyof typeof WAIT_KIND];

/** The values of `otheater.closed_by`. */
export const CLOSED_BY = {
  playEnd: 'play_end',
  attemptEnd: 'attempt_end',
  /** A wait of the pool that a restart of the daemon cut short (its sessions did not survive). */
  daemonRestart: 'daemon_restart',
} as const;

/**
 * `gen_ai.provider.name` of a client (the id of its adapter). Claude Code and Codex talk to one
 * provider each; OpenCode talks to whichever its profile names, which the daemon does not read
 * here, so it is named by the client. An unknown client is named by its id.
 */
const PROVIDER_OF_CLIENT: Readonly<Record<string, string>> = {
  'claude-code': 'anthropic',
  codex: 'openai',
  opencode: 'opencode',
};

export function providerNameOf(client: string): string {
  return PROVIDER_OF_CLIENT[client] ?? client;
}

/** The attributes of the resource every span of the daemon carries. */
export const DAEMON_SPAN_RESOURCE = {
  'service.name': 'otheater',
  'otheater.component': 'daemon',
} as const;
