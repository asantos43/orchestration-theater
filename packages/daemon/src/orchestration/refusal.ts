// SPDX-License-Identifier: MPL-2.0
import { isAbsolute, relative, sep } from 'node:path';
import { z } from 'zod';

/**
 * What the Director gets to judge point 6 (`refusal_or_permission`, N181): the permissions layer 2
 * denied to the Actor in the attempt that ended. [proposta] The machine event `ACTOR_REFUSED`
 * carries only the demand (its schema is the one of the architecture), so the daemon writes this
 * summary on the blackboard, key `refusal:<demand>`, before it sends the event, and the effect
 * that opens the decision copies it into the `input` of the decision as `refused`.
 */
export function refusalKey(demandId: string): string {
  return `refusal:${demandId}`;
}

/** At most this many tools and paths are kept, and each text is cut: the Director reads a summary. */
export const REFUSAL_MAX_ITEMS = 8;
export const REFUSAL_MAX_TEXT = 200;

export const RefusalSchema = z.strictObject({
  /** The attempt that was refused. */
  attempt: z.int().min(1),
  /** How the attempt ended: with a `blocked` result, or with nothing changed in the worktree. */
  ended: z.enum(['blocked', 'no_change']),
  /** How many requests layer 2 denied (`reject`, or `cancelled` when no option fitted). */
  denied: z.int().min(1),
  /** The tools that were denied, without repeats. */
  tools: z.array(z.string()),
  /** The files they touched, relative to the worktree when they are inside it. */
  paths: z.array(z.string()),
  /** Why layer 2 denied them (`on_ask_reject`, `no_rule`...), without repeats. */
  reasons: z.array(z.string()),
  /** What the Actor said when it finished blocked; null when it did not say. */
  actorReason: z.string().nullable(),
});
export type Refusal = z.infer<typeof RefusalSchema>;

/** One `permission.answered` of an attempt, as much of it as the summary needs. */
export interface PermissionAnswer {
  readonly answer: string;
  readonly tool: string;
  readonly paths: readonly string[];
  readonly reason: string;
}

/** Layer 2 turned the request down: a rejection, or a cancel because no option could allow it. */
export function wasDenied(answer: string): boolean {
  return answer === 'reject' || answer === 'cancelled';
}

function cut(text: string): string {
  return text.length <= REFUSAL_MAX_TEXT ? text : `${text.slice(0, REFUSAL_MAX_TEXT - 1)}…`;
}

/** A path inside the worktree is shown relative to it, so the summary names no directory of the host. */
function shown(worktree: string, path: string): string {
  if (!isAbsolute(path)) return path;
  const inside = relative(worktree, path);
  return inside !== '' && inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)
    ? inside
    : path;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].slice(0, REFUSAL_MAX_ITEMS).map(cut);
}

/**
 * Sums up the denied requests of an attempt, or `undefined` when layer 2 denied none (then the
 * attempt is not a refusal and goes on as it always did).
 */
export function summarizeRefusal(
  answers: readonly PermissionAnswer[],
  detail: {
    readonly attempt: number;
    readonly ended: Refusal['ended'];
    readonly worktree: string;
    readonly actorReason: string | undefined;
  },
): Refusal | undefined {
  const denied = answers.filter((a) => wasDenied(a.answer));
  if (denied.length === 0) return undefined;
  return {
    attempt: detail.attempt,
    ended: detail.ended,
    denied: denied.length,
    tools: unique(denied.map((a) => a.tool)),
    paths: unique(denied.flatMap((a) => a.paths.map((path) => shown(detail.worktree, path)))),
    reasons: unique(denied.map((a) => a.reason)),
    actorReason: detail.actorReason === undefined ? null : cut(detail.actorReason),
  };
}
