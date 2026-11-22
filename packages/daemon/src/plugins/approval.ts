// SPDX-License-Identifier: MPL-2.0
import { APPROVE_LABEL, DENY_LABEL, isApproval, type AskApproval } from '../browser/approval.js';
import type { PluginPermissionSettings } from './permissions.js';

/**
 * The card the Producer answers before a plugin tool runs (`requires_producer_approval`, or
 * `external_write` under `plugins.permissions.external_write_approval: ask`; Phase 9, P6 and P10).
 * The two doors that ask, the `otheater` MCP server (a call of an agent) and the panel of the
 * plugin (an action the Producer clicked), use the same text and the same rules, so they are one
 * thing here: no answer is a yes, and a free text is a no (`isApproval`).
 */

/** How a question to the Producer ended. Only `approved` lets the call run. */
export type ApprovalOutcome =
  'approved' | 'approval_unavailable' | 'approval_cancelled' | 'approval_denied';

/** What the card shows of the arguments (`plugins.permissions.approval_detail`): never more. */
export function approvalDetailOf(
  args: Record<string, unknown> | undefined,
  mode: PluginPermissionSettings['approvalDetail'],
): string {
  if (args === undefined || Object.keys(args).length === 0) return 'no arguments';
  if (mode === 'values') return `arguments ${JSON.stringify(args).slice(0, 300)}`;
  return `arguments: ${Object.keys(args).join(', ').slice(0, 200)}`;
}

/**
 * Asks the Producer through the prompt queue of the project. `approval_unavailable` when nobody can
 * be asked (no channel, or the channel failed), `approval_cancelled` when the question ended with no
 * answer, `approval_denied` for anything that is not an exact yes.
 */
export async function askProducerToApprove(
  ask: AskApproval | undefined,
  project: string,
  question: string,
): Promise<ApprovalOutcome> {
  const opened =
    ask === undefined
      ? undefined
      : await ask(project, {
          questions: [
            {
              question,
              options: [
                { label: APPROVE_LABEL, description: 'Run this call; the next call asks again.' },
                {
                  label: DENY_LABEL,
                  description: 'Do not run it; the agent is told it was refused.',
                },
              ],
              multi_select: false,
              open: false,
              recommended: DENY_LABEL,
            },
          ],
        }).catch(() => undefined);
  if (opened === undefined) return 'approval_unavailable';
  try {
    return isApproval(await opened.answer) ? 'approved' : 'approval_denied';
  } catch {
    return 'approval_cancelled';
  }
}
