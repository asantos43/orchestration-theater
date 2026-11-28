// SPDX-License-Identifier: MPL-2.0
import { PUBLIC_WRITES, type PublicWrite } from '@otheater/workflows';

/**
 * `workflows.security` and `workflows.codehost` as the code host steps read them (docs/24 §9 and
 * §12; plan of Phase 11b, P8). The schema is in `config.ts`.
 *
 * - `security.require_approval`: the public writes that need an `approval` first. `[push, comment,
 *   label]` (default; docs/24 §12), `none` or a list of those. The validator of P1 refuses a
 *   definition without the approval; the step checks it again at run time.
 * - `security.untrusted_text` [proposta]: `mark` puts the external text (issue, pull request,
 *   comment, CI log) in a block marked as not trusted; `mark_and_truncate` (default, the closed
 *   default of docs/24 §9) also cuts it to `untrusted_max_chars`.
 * - `security.untrusted_max_chars` [proposta]: the cut of `mark_and_truncate`, in characters.
 * - `codehost.comment_marker` [proposta]: `on` (default) ends the body of a comment with a hidden
 *   marker that carries the idempotency key, so a verifier can find the comment after a crash;
 *   `off` posts the body as it is.
 */
export const WORKFLOW_UNTRUSTED_TEXT_MODES = ['mark', 'mark_and_truncate'] as const;
export type WorkflowUntrustedTextMode = (typeof WORKFLOW_UNTRUSTED_TEXT_MODES)[number];

export const WORKFLOW_COMMENT_MARKER_MODES = ['on', 'off'] as const;
export type WorkflowCommentMarkerMode = (typeof WORKFLOW_COMMENT_MARKER_MODES)[number];

/** The value of `workflows.security.require_approval` that asks for no approval. */
export const REQUIRE_APPROVAL_NONE = 'none';

export interface WorkflowSecuritySettings {
  /** The public writes that need an approval; empty for `none`. */
  readonly requireApproval: readonly PublicWrite[];
  readonly untrustedText: WorkflowUntrustedTextMode;
  readonly untrustedMaxChars: number;
  readonly commentMarker: WorkflowCommentMarkerMode;
}

/** The defaults, for an engine built without a configuration. */
export const DEFAULT_WORKFLOW_SECURITY: WorkflowSecuritySettings = {
  requireApproval: PUBLIC_WRITES,
  untrustedText: 'mark_and_truncate',
  untrustedMaxChars: 20_000,
  commentMarker: 'on',
};

/** The part of the resolved `workflows` block this module reads (structural, like `WorkflowsConfigView`). */
export interface WorkflowSecurityConfigView {
  readonly security: {
    readonly require_approval: typeof REQUIRE_APPROVAL_NONE | readonly PublicWrite[];
    readonly untrusted_text: WorkflowUntrustedTextMode;
    readonly untrusted_max_chars: number;
  };
  readonly codehost: { readonly comment_marker: WorkflowCommentMarkerMode };
}

/** `workflows.security` and `workflows.codehost` of the resolved configuration as the settings the steps read. */
export function workflowSecuritySettings(
  config: WorkflowSecurityConfigView,
): WorkflowSecuritySettings {
  const { security, codehost } = config;
  return {
    requireApproval:
      security.require_approval === REQUIRE_APPROVAL_NONE ? [] : security.require_approval,
    untrustedText: security.untrusted_text,
    untrustedMaxChars: security.untrusted_max_chars,
    commentMarker: codehost.comment_marker,
  };
}
