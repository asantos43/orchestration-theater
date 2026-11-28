// SPDX-License-Identifier: MPL-2.0
import type { StepRunner } from '../types.js';
import { fetchCiLogStep, fetchIssueStep, fetchPrStep } from './fetch.js';
import { commentStep, labelStep } from './write.js';

export { fetchCiLogStep, fetchIssueStep, fetchPrStep, commentStep, labelStep };
export {
  CODE_HOST_EFFECT_TYPES,
  registerCodeHostEffects,
  verifyComment,
  verifyLabel,
} from './effects.js';
export {
  commentMarker,
  guardPublicWrite,
  type CodeHostStepDeps,
  type CommentFinder,
  type FoundComment,
} from './support.js';

/**
 * The code of the five code host step types (docs/24 §4; plan of Phase 11b, P8). Whoever builds the
 * runtime adds them to `GENERIC_STEP_RUNNERS` (`steps: [...GENERIC_STEP_RUNNERS, ...CODE_HOST_STEP_RUNNERS]`)
 * and gives `codeHost` (the ports and the security settings) to the options of the runtime.
 */
export const CODE_HOST_STEP_RUNNERS: readonly StepRunner[] = [
  fetchIssueStep,
  fetchPrStep,
  fetchCiLogStep,
  commentStep,
  labelStep,
];
