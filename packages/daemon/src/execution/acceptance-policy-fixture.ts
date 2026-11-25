// SPDX-License-Identifier: MPL-2.0
// Shared by the acceptance tests of the execution only (excluded from the build of the package).
import type { EventEnvelope, RolePolicy } from '@otheater/core';
import { defaultPolicySettings } from '../orchestration/role-policy.js';

/** A role that only reads: no edit, no shell, every ask rejected (5.8). */
export const READ_ONLY: RolePolicy = {
  nativeTools: ['read', 'search'],
  nativeShell: 'none',
  mcpServers: [],
  mcpTools: {},
  onAsk: 'reject',
  bypass: 'forbidden',
  writeScope: 'worktree',
  network: { allow: [] },
};

/**
 * A role that has the edit tools but no `editInWorktree` (absent counts as `ask`): Claude Code opens
 * in `default` and every edit reaches layer 2, which rejects it. The simulated `edit-file` attempt
 * uses it to show a refused edit over the real transport.
 */
export const ASKING_WRITER: RolePolicy = {
  ...READ_ONLY,
  nativeTools: ['read', 'search', 'edit', 'write'],
};

/**
 * A role that writes the way the Actor does by default (N182): `editInWorktree` comes from
 * {@link defaultPolicySettings}, so the fixture follows the default of the product. Claude Code
 * opens in `acceptEdits`, and an edit that still asks is allowed by layer 2 inside the worktree.
 * [V: 2026-11-25] The real acceptance used {@link ASKING_WRITER} for the drafts of the real clients,
 * so each `Write` of Claude Code asked, was rejected, and `draft.txt` never came.
 */
export const WRITER: RolePolicy = {
  ...ASKING_WRITER,
  editInWorktree: defaultPolicySettings('actor').editInWorktree,
};

/** One `permission.answered` of layer 2 that did not allow an edit. */
export interface RefusedEdit {
  readonly tool: string;
  readonly answer: string;
  readonly rule: string;
  readonly reason: string;
  readonly paths: readonly string[];
}

/** The edits layer 2 did not allow in an attempt, in order (`permission.answered`, kind `edit`). */
export function refusedEditsOf(events: readonly EventEnvelope[], attemptId: string): RefusedEdit[] {
  const refused: RefusedEdit[] = [];
  for (const event of events) {
    if (event.attemptId !== attemptId || event.type !== 'permission.answered') continue;
    const payload = event.payload as Record<string, unknown>;
    if (payload.kind !== 'edit' || payload.answer === 'allow') continue;
    refused.push({
      tool: String(payload.tool),
      answer: String(payload.answer),
      rule: String(payload.rule),
      reason: String(payload.reason),
      paths: Array.isArray(payload.paths) ? payload.paths.map(String) : [],
    });
  }
  return refused;
}
