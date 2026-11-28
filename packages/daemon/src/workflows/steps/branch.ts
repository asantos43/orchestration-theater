// SPDX-License-Identifier: MPL-2.0
import { NO_STEP_OUTPUT, type StepRunner } from './types.js';

/**
 * `branch` (docs/24 §4): chooses the edge by condition and does nothing else. The choice is made by
 * the machine from the edges that leave the node; the step itself has no work, no output and no
 * effect.
 */
export const branchStep: StepRunner = {
  type: 'branch',
  run: () => Promise.resolve({ kind: 'done', output: NO_STEP_OUTPUT }),
};
