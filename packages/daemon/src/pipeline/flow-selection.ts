// SPDX-License-Identifier: MPL-2.0
import { createHash } from 'node:crypto';
import {
  canonicalFlowJson,
  describeFlowProblems,
  flowLimitOverrides,
  parseFlowConfig,
  skippedSteps,
  type ResolvedFlow,
  type ScenarioRegistry,
} from '@otheater/core';
import type { DaemonConfig, PlayLimits } from '../config.js';
import { OFFICIAL_PLAY_FLOW_ID } from '../flows-config.js';
import { scenarioChain } from '../orchestration/role-policy.js';
import type { PlayFlowRef } from './context.js';

/**
 * Which flow a new play runs, and what it takes from it (plan of Phase 9, P12). The choice is
 * `scenario.flow` of the configuration, overridden by the `configOverride` of the scenario (after
 * the one of the scenario it was promoted from, oldest first) like the policy of a role. It is made
 * once, when the play opens: the resolved steps and limits go into the play, and the play never
 * reads the configuration again.
 */

/** The key a layer of `configOverride` writes, flat or nested (`{ scenario: { flow } }`). */
export const SCENARIO_FLOW_OVERRIDE_KEY = 'scenario.flow';

export type FlowSelection =
  | {
      readonly ok: true;
      /** `undefined`: the official `play`, run as it always was. */
      readonly flow: PlayFlowRef | undefined;
      /** The limits of the play: the ones of `limits` with the ones of the flow on top. */
      readonly limits: PlayLimits;
    }
  | { readonly ok: false; readonly message: string };

/** sha256 (hex) of the canonical text of a resolved flow. */
export function flowHashOf(flow: ResolvedFlow): string {
  return createHash('sha256').update(canonicalFlowJson(flow)).digest('hex');
}

/** The reference a play keeps in its snapshot. */
export function flowRefOf(flow: ResolvedFlow): PlayFlowRef {
  return {
    id: flow.id,
    version: flow.version,
    hash: flowHashOf(flow),
    skip: skippedSteps(flow),
  };
}

/** What a layer of `configOverride` says: the id, `undefined` (no key) or a problem. */
function layerChoice(
  override: Readonly<Record<string, unknown>>,
): { readonly id: string | undefined } | { readonly problem: string } {
  const nested = override.scenario;
  const value =
    override[SCENARIO_FLOW_OVERRIDE_KEY] ??
    (typeof nested === 'object' && nested !== null && !Array.isArray(nested)
      ? (nested as Record<string, unknown>).flow
      : undefined);
  if (value === undefined) return { id: undefined };
  if (typeof value !== 'string' || value === '') {
    return { problem: 'scenario.flow must be the id of a flow' };
  }
  return { id: value };
}

/**
 * Picks the flow of a play of `scenarioId` and folds its limits into `base`. A choice that names
 * no flow, or a flow that does not validate, refuses the play with the problems: it never falls
 * back to the official `play` on its own.
 */
export async function selectFlow(
  deps: {
    readonly config: Pick<DaemonConfig, 'flows' | 'scenario'>;
    readonly scenarios: Pick<ScenarioRegistry, 'get'>;
  },
  scenarioId: string,
  base: PlayLimits,
): Promise<FlowSelection> {
  let id = deps.config.scenario.flow;
  for (const record of await scenarioChain(deps.scenarios, scenarioId)) {
    const layer = layerChoice(record.configOverride);
    if ('problem' in layer) {
      return { ok: false, message: `scenario "${record.id}" configOverride: ${layer.problem}` };
    }
    if (layer.id !== undefined) id = layer.id;
  }
  if (id === undefined || id === OFFICIAL_PLAY_FLOW_ID)
    return { ok: true, flow: undefined, limits: base };
  const written = deps.config.flows[id];
  if (written === undefined) {
    return {
      ok: false,
      message: `scenario.flow names "${id}", which is not "${OFFICIAL_PLAY_FLOW_ID}" nor a key of flows`,
    };
  }
  const parsed = parseFlowConfig(id, written);
  if (!parsed.ok) {
    return {
      ok: false,
      message: `The flow "${id}" is not valid:\n${describeFlowProblems(parsed.problems)}`,
    };
  }
  return {
    ok: true,
    flow: flowRefOf(parsed.flow),
    limits: { ...base, ...flowLimitOverrides(parsed.flow) },
  };
}
