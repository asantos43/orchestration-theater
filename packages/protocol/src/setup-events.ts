// SPDX-License-Identifier: MPL-2.0
import { ROLE_PRESET_NAMES } from '@otheater/core';
import { z } from 'zod';
import { SetupFlowSchema, SetupRunIdSchema, SetupStepIdSchema } from './api/setup.js';

/**
 * Payloads of the events of the setup assistant (architecture 5.7; P4 of docs/18). Registered in
 * `DAEMON_EVENT_DEFINITIONS` (events.ts) at `schemaVersion` 1. [proposta] None of them carries
 * what the Producer typed, a key, a URL or a path: only the run, the flow and the step, so a hook
 * or a plugin can follow the assistant. `setup.confirmed` lists the Executor ids and the keys of
 * `config.yaml` that were written, which are names and not values.
 */

/** A run was started. */
export const SetupStartedPayloadSchema = z.strictObject({
  runId: SetupRunIdSchema,
  flow: SetupFlowSchema,
  /** The first step of the flow. */
  step: SetupStepIdSchema,
});

/** A step was answered and accepted; `next` is the step the run is at now. */
export const SetupStepPayloadSchema = z.strictObject({
  runId: SetupRunIdSchema,
  flow: SetupFlowSchema,
  step: SetupStepIdSchema,
  next: SetupStepIdSchema,
});

/** The run went back one step; `step` is the step it is at now (the one whose state was undone). */
export const SetupBackPayloadSchema = z.strictObject({
  runId: SetupRunIdSchema,
  flow: SetupFlowSchema,
  step: SetupStepIdSchema,
});

/** The review was confirmed and the configuration was written. */
export const SetupConfirmedPayloadSchema = z.strictObject({
  runId: SetupRunIdSchema,
  flow: SetupFlowSchema,
  preset: z.enum(ROLE_PRESET_NAMES).nullable(),
  executors: z.array(z.string().min(1)),
  written: z.array(z.string().min(1)),
});

/** The run was cancelled; the configuration was not touched. */
export const SetupCancelledPayloadSchema = z.strictObject({
  runId: SetupRunIdSchema,
  flow: SetupFlowSchema,
  /** The step it was at. */
  step: SetupStepIdSchema,
});
