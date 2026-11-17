// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';

/**
 * Payloads of the events of the work tools, the "cascas" (architecture 5.8, N97 and N98): every
 * call of `restricted_shell`, `run_tests`, `install_deps`, `git_commit`, `view_diff` and
 * `http_get` is a `tool.called` followed by a `tool.finished`. They are registered in
 * `DAEMON_EVENT_TYPES` (events.ts) at `schemaVersion` 1. Every payload is a strict object.
 * [proposta] The names and fields.
 *
 * `callId` ties the two events of one call. The events never carry the output of the command (it
 * goes back to the Executor only) nor the body of an HTTP answer: only sizes.
 */

const id = z.string().min(1).max(256);

const correlation = {
  playId: id.optional(),
  demandId: id.optional(),
  attemptId: id.optional(),
};

/** `tool.finished` outcome: how the call ended. */
export const TOOL_OUTCOMES = ['ok', 'failed', 'refused', 'timed_out', 'error'] as const;
export type ToolOutcome = (typeof TOOL_OUTCOMES)[number];

/**
 * `tool.called`: the call passed the checks (schema, role) and is about to run, or to wait for
 * the heavy-command semaphore. `summary` is what the call does in one line (the argv, the URL, the
 * first line of the commit message), cut to 500 characters; `heavy` says the call counts toward
 * `tools.heavy_concurrency`.
 */
export const ToolCalledPayloadSchema = z.strictObject({
  tool: id,
  role: id,
  callId: id,
  summary: z.string().max(500),
  heavy: z.boolean(),
  ...correlation,
});

/**
 * `tool.finished`: the call ended. `outcome` is `ok` (it ran and the command exited 0, or the
 * tool did its work), `failed` (it ran and the command exited with another code), `refused` (the
 * argv or the path rules said no, nothing ran), `timed_out` (`tools.timeout_ms`, the tree was
 * killed) or `error` (the tool itself failed). `errorCode` is the stable code the Executor got.
 * `queuedMs` is how long the call waited for the semaphore; `durationMs` counts the run only.
 */
export const ToolFinishedPayloadSchema = z.strictObject({
  tool: id,
  role: id,
  callId: id,
  outcome: z.enum(TOOL_OUTCOMES),
  exitCode: z.int().nullable().optional(),
  errorCode: id.optional(),
  durationMs: z.int().min(0),
  queuedMs: z.int().min(0),
  /** Size of what the call produced (stdout plus stderr, or the body), before the cut. */
  outputBytes: z.int().min(0).optional(),
  truncated: z.boolean().optional(),
  ...correlation,
});
