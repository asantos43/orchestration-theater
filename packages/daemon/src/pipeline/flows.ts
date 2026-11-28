// SPDX-License-Identifier: MPL-2.0
import { InvalidInput, type Registries } from '@otheater/core';
import { loadPlayDefinition } from '../workflows/definitions/play-definition.js';
import { PLAY_FLOW_ID, PLAY_FLOW_VERSION } from './definitions.js';
import { PLAY_EVENT_DEFINITIONS } from './events.js';
import { STAGE_ROLES } from './effects.js';

/**
 * Links the play to the `play` entry of the flow registry (architecture 5.18). The registry is the
 * descriptor, and since the `play` 2.0 (Phase 11b, P3) the definition `play.yaml` is the contract of
 * the play: start-up checks that the definition validates and agrees with the machine (the states,
 * the step types, the counters, the major version), that the registry has the same version (a
 * snapshot is only restored on the same one), that the roles the machine runs are roles of the
 * flow, and that the events it writes are registered. Rejects with `InvalidInput` listing every
 * difference.
 */
export function assertPlayFlowLinked(registries: Registries): void {
  const problems: string[] = [];
  const definition = loadPlayDefinition();
  if (!definition.ok) problems.push(...definition.problems);
  const flow = registries.flows.get(PLAY_FLOW_ID);
  if (flow === undefined) {
    problems.push(`flows/${PLAY_FLOW_ID}: the flow of the play machine is not registered`);
  } else {
    if (flow.version !== PLAY_FLOW_VERSION) {
      problems.push(
        `flows/${PLAY_FLOW_ID}: the registry has version ${String(flow.version)} and the machine ` +
          `is version ${String(PLAY_FLOW_VERSION)}`,
      );
    }
    for (const role of new Set(Object.values(STAGE_ROLES))) {
      if (!flow.roles.includes(role)) {
        problems.push(
          `flows/${PLAY_FLOW_ID}: the machine runs the role "${role}", the flow does not list it`,
        );
      }
    }
  }
  for (const definition of PLAY_EVENT_DEFINITIONS) {
    if (!registries.events.has(definition.type)) {
      problems.push(
        `events/${definition.type}: the play machine writes it, but it is not registered`,
      );
    }
  }
  if (problems.length > 0) {
    throw new InvalidInput(
      `The play does not match its definition and the registries:\n${problems.join('\n')}`,
    );
  }
}
