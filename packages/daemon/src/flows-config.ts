// SPDX-License-Identifier: MPL-2.0
import { FlowConfigSchema, parseFlowConfig } from '@otheater/core';
import { z } from 'zod';

/**
 * The flows of the configuration (architecture 5.4 and 5.18; plan of Phase 9, P12; N133, N241).
 * Kept apart from `config.ts` like `role-policy-config.ts`, which only imports it.
 *
 * - `flows.<id>` (default `{}`): the official `play` with optional steps on or off and the limits
 *   of each step (`FlowConfigSchema` of the core). The validator is the one of the core
 *   (`parseFlowConfig`): a mandatory step that is off, a role that is not the step's own, a
 *   limit on a step that is off, or an id of an official flow is refused with the path of the field.
 *   [proposta] Only version 1 of the format; no key releases a permission.
 * - `scenario.flow` (default: absent = the official `play`): the flow a new play runs. [proposta]
 *   A scenario overrides it through its `configOverride` (`scenario.flow`, flat or nested), after
 *   the one of the scenario it was promoted from, like the policy of a role. The play fixes the
 *   flow when it opens: a change of the keys later does not touch it.
 */

/** The id `scenario.flow` takes for the official `play` (the same as writing no key). */
export const OFFICIAL_PLAY_FLOW_ID = 'play';

export const FlowsConfigSchema = z
  .record(z.string(), FlowConfigSchema)
  .superRefine((flows, ctx) => {
    for (const [id, flow] of Object.entries(flows)) {
      const result = parseFlowConfig(id, flow, []);
      if (result.ok) continue;
      for (const problem of result.problems) {
        ctx.addIssue({
          code: 'custom',
          path: problem.segments.filter(
            (part): part is string | number => typeof part !== 'symbol',
          ),
          message: problem.message,
        });
      }
    }
  });

export const ScenarioConfigSchema = z.strictObject({
  /** The id of a flow of `flows`, or `play` (the default). */
  flow: z.string().min(1).optional(),
});

/** What `scenario.flow` may name: `play` or a key of `flows`. */
export function scenarioFlowProblem(config: {
  readonly flows: Readonly<Record<string, unknown>>;
  readonly scenario: { readonly flow?: string | undefined };
}): string | undefined {
  const id = config.scenario.flow;
  if (id === undefined || id === OFFICIAL_PLAY_FLOW_ID || id in config.flows) return undefined;
  return `scenario.flow names "${id}", which is not "${OFFICIAL_PLAY_FLOW_ID}" nor a key of flows`;
}
