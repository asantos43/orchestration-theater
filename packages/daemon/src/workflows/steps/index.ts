// SPDX-License-Identifier: MPL-2.0
import { approvalStep } from './approval.js';
import { branchStep } from './branch.js';
import { callToolStep } from './call-tool.js';
import { notifyStep } from './notify.js';
import type { StepRunner } from './types.js';
import { waitEventStep } from './wait-event.js';

export { approvalStep, branchStep, callToolStep, notifyStep, waitEventStep };

/**
 * The code of the five generic step types (docs/24 §4; plan of Phase 11b, P2). The step types of
 * the code host and of the `play` come with their own steps (P3, P5) and are added to this list by
 * whoever builds the runtime.
 */
export const GENERIC_STEP_RUNNERS: readonly StepRunner[] = [
  callToolStep,
  waitEventStep,
  branchStep,
  approvalStep,
  notifyStep,
];
