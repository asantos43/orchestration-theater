// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';

/**
 * The output of the judgment point `group_ideas` (architecture 5.20, decision N91). [proposta]
 * The Author reads the queue of a scenario and answers, through `submit_idea_group`:
 * - the `group`: the ideas that go into the next play, in the order they should be done, with
 *   the need the play will receive;
 * - `leftOut`: the ideas that stay in the queue for a later grouping, each with its reason (and
 *   a question, when only the Producer can untie it);
 * - `discarded`, `deferred` and `split`: the ideas the Author drops, postpones or breaks in
 *   parts, always with the reason.
 *
 * One source for the tool and for the daemon: the tool validates its input with this schema, so a
 * wrong shape goes back to the model inside the `limits.submit_retries` loop, and the daemon reads
 * the accepted output with the same schema.
 */

// The same pattern as `IDEA_ID_PATTERN` (ports/ideas.ts); the registries import nothing outside.
const ideaId = z.string().regex(/^I[1-9][0-9]*$/, 'an idea id looks like "I3"');
const reason = z.string().trim().min(1, 'give the reason');

export const ideaGroupMember = z.strictObject({
  ideaId,
  reason: reason.describe('Why this idea is left out, discarded or deferred.'),
});

export const ideaGroupLeftOut = z.strictObject({
  ideaId,
  reason: reason.describe('Why it does not go in this group (it stays queued).'),
  question: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('A question only the Producer can answer, when the idea is ambiguous or clashes.'),
});

export const ideaGroupSplit = z.strictObject({
  ideaId,
  reason: reason.describe('Why the idea is too big or mixed, and how you cut it.'),
  parts: z
    .array(z.string().trim().min(1))
    .min(2)
    .describe('The parts, each one an idea of its own; they join the queue.'),
});

export const ideaGroupOutput = z
  .looseObject({
    group: z
      .strictObject({
        ideaIds: z
          .array(ideaId)
          .describe('The ideas of the next play, in the order they should be done; may be empty.'),
        need: z
          .string()
          .trim()
          .describe('The need of the play: what to do, covering every idea of the group.'),
        rationale: z.string().trim().describe('Why these ideas go together.'),
      })
      .describe('The group for the next play.'),
    leftOut: z.array(ideaGroupLeftOut).default([]),
    discarded: z.array(ideaGroupMember).default([]),
    deferred: z.array(ideaGroupMember).default([]),
    split: z.array(ideaGroupSplit).default([]),
  })
  .superRefine((out, ctx) => {
    if (out.group.ideaIds.length > 0) {
      if (out.group.need === '') {
        ctx.addIssue({
          code: 'custom',
          path: ['group', 'need'],
          message: 'a group with ideas needs the need of the play',
        });
      }
      if (out.group.rationale === '') {
        ctx.addIssue({
          code: 'custom',
          path: ['group', 'rationale'],
          message: 'a group with ideas needs the reason they go together',
        });
      }
    }
    // An idea is in one list only.
    const seen = new Set<string>();
    const lists: readonly (readonly [string, readonly string[]])[] = [
      ['group.ideaIds', out.group.ideaIds],
      ['leftOut', out.leftOut.map((item) => item.ideaId)],
      ['discarded', out.discarded.map((item) => item.ideaId)],
      ['deferred', out.deferred.map((item) => item.ideaId)],
      ['split', out.split.map((item) => item.ideaId)],
    ];
    for (const [path, ids] of lists) {
      for (const id of ids) {
        if (seen.has(id)) {
          ctx.addIssue({
            code: 'custom',
            path: [path],
            message: `the idea ${id} appears twice; each idea goes in exactly one list`,
          });
        }
        seen.add(id);
      }
    }
  });
export type IdeaGroupOutput = z.infer<typeof ideaGroupOutput>;

/**
 * What is wrong with an accepted answer against the queue it was made for: an idea the queue
 * does not have, an idea of the queue that was not placed in any list, or a group bigger than
 * `maxPerPlay`. Empty when the answer is coherent. (The schema alone cannot know the queue.)
 */
export function checkIdeaGroup(
  output: IdeaGroupOutput,
  queuedIds: readonly string[],
  maxPerPlay: number,
): readonly string[] {
  const problems: string[] = [];
  const queue = new Set(queuedIds);
  const placed = new Set<string>();
  const all = [
    ...output.group.ideaIds,
    ...output.leftOut.map((item) => item.ideaId),
    ...output.discarded.map((item) => item.ideaId),
    ...output.deferred.map((item) => item.ideaId),
    ...output.split.map((item) => item.ideaId),
  ];
  for (const id of all) {
    if (queue.has(id)) placed.add(id);
    else problems.push(`${id} is not in the queue`);
  }
  for (const id of queuedIds) {
    if (!placed.has(id)) problems.push(`${id} was not placed in any list`);
  }
  if (output.group.ideaIds.length > maxPerPlay) {
    problems.push(
      `the group has ${String(output.group.ideaIds.length)} ideas; the limit is ${String(maxPerPlay)}`,
    );
  }
  return problems;
}
