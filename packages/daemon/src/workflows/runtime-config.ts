// SPDX-License-Identifier: MPL-2.0
/**
 * The modes of `workflows.runtime.approval.on_timeout` (plan of Phase 11b, P2). [proposta] The
 * same two the `approval` step takes in its own `on_timeout`: `stop` ends the run as cancelled,
 * `reject` gives `approved: false` and lets the edges decide.
 */
export const WORKFLOW_APPROVAL_ON_TIMEOUT = ['stop', 'reject'] as const;
export type WorkflowApprovalOnTimeout = (typeof WORKFLOW_APPROVAL_ON_TIMEOUT)[number];

/**
 * `workflows.runtime` as the engine reads it (plan of Phase 11b, P2). Every key is [proposta]; the
 * schema is in `config.ts`. A duration is in milliseconds; `null` is `off`.
 */
export interface WorkflowRuntimeSettings {
  /** `wait_event.poll`: how often the log is read while a `wait_event` waits. */
  readonly waitEventPollMs: number;
  /** `approval.timeout`: the deadline of an `approval` whose node names none; `null` waits for ever. */
  readonly approvalTimeoutMs: number | null;
  /** `approval.on_timeout`: what an `approval` does at its deadline when the node names no mode. */
  readonly approvalOnTimeout: WorkflowApprovalOnTimeout;
  /** `call_tool.timeout`: the deadline of a `call_tool` whose node names none; `null`: only `plugins.call_timeout`. */
  readonly callToolTimeoutMs: number | null;
}

/** The defaults of `workflows.runtime`, for an engine built without a configuration. */
export const DEFAULT_WORKFLOW_RUNTIME: WorkflowRuntimeSettings = {
  waitEventPollMs: 2_000,
  approvalTimeoutMs: null,
  approvalOnTimeout: 'stop',
  callToolTimeoutMs: null,
};

/** `workflows.runtime` of the resolved configuration as the settings the engine reads. */
export function workflowRuntimeSettings(
  config: DaemonConfig['workflows'],
): WorkflowRuntimeSettings {
  const { runtime } = config;
  return {
    waitEventPollMs: runtime.wait_event.poll,
    approvalTimeoutMs: runtime.approval.timeout,
    approvalOnTimeout: runtime.approval.on_timeout,
    callToolTimeoutMs: runtime.call_tool.timeout,
  };
}
