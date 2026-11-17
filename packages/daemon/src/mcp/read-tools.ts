// SPDX-License-Identifier: MPL-2.0
import { contractKey, type BlackboardEntry, type Store } from '@otheater/core';
import { ToolFailure, type ToolCall, type ToolHandler, type ToolHandlers } from './handlers.js';

/** What the read tools need of the store. */
export type ReadToolsStore = Pick<Store, 'blackboard' | 'decisions' | 'plays'>;

/** The tools of this file, in the order they are registered. */
export const READ_TOOL_NAMES = ['read_blackboard', 'read_contract', 'read_decision'] as const;

/**
 * An entry as the Executor sees it. The version is always there, so a caller that asked for the
 * latest knows which one it got and can ask for it again later.
 */
function entryReply(entry: BlackboardEntry): Record<string, unknown> {
  return {
    key: entry.key,
    version: entry.version,
    value: entry.value,
    author: entry.author,
    createdAt: entry.createdAt,
  };
}

function noPlay(tool: string): ToolFailure {
  return new ToolFailure(
    'no_play',
    `${tool} reads the blackboard of a play, and this session is not tied to one.`,
  );
}

async function readKey(
  store: ReadToolsStore,
  call: ToolCall,
  label: string,
  key: string,
  version: number | undefined,
): Promise<Record<string, unknown> | ToolFailure> {
  const { playId } = call.caller.correlation;
  if (playId === undefined) return noPlay(call.tool.name);
  const entry = await store.blackboard.get(playId, key, version);
  if (entry !== undefined) return entryReply(entry);
  const latest = version === undefined ? undefined : await store.blackboard.get(playId, key);
  const hint =
    latest === undefined
      ? ''
      : ` The latest version is ${String(latest.version)}; omit "version" to read it.`;
  return new ToolFailure(
    'not_found',
    version === undefined
      ? `${label} has no entry in the blackboard of this play.`
      : `${label} has no version ${String(version)}.${hint}`,
  );
}

/**
 * The handlers of `read_blackboard`, `read_contract` and `read_decision` (architecture 5.4 and
 * 5.3, P7). All three read only what the caller's own play (and scenario) holds, so an Executor
 * never sees another play through them.
 *
 * - `read_blackboard {key, version?}`: the version asked for, or the latest.
 * - `read_contract {id, version?}`: the blackboard key `contract/<id>` ({@link contractKey}),
 *   with the same version rule. [proposta]
 * - `read_decision {id}`: the decision row, when it belongs to the caller's scenario and is
 *   either of the caller's play or not tied to a play. A decision of another play answers
 *   `not_found`, as an unknown id does.
 *
 * A miss is returned as a {@link ToolFailure} (`not_found`), not thrown.
 */
export function readToolHandlers(store: ReadToolsStore): Readonly<Record<string, ToolHandler>> {
  return {
    read_blackboard: (call) => {
      const { key, version } = call.input as { key: string; version?: number };
      return readKey(store, call, `The key "${key}"`, key, version);
    },
    read_contract: (call) => {
      const { id, version } = call.input as { id: string; version?: number };
      return readKey(store, call, `The contract "${id}"`, contractKey(id), version);
    },
    read_decision: async (call) => {
      const { id } = call.input as { id: string };
      const { playId } = call.caller.correlation;
      if (playId === undefined) return noPlay(call.tool.name);
      const [play, decision] = await Promise.all([
        store.plays.get(playId),
        store.decisions.get(id),
      ]);
      const notFound = new ToolFailure(
        'not_found',
        `The decision "${id}" does not exist for this play.`,
      );
      if (play === undefined || decision === undefined) return notFound;
      if (decision.scenarioId !== play.scenarioId) return notFound;
      if (decision.playId !== null && decision.playId !== playId) return notFound;
      return {
        id: decision.id,
        kind: decision.kind,
        playId: decision.playId,
        state: decision.state,
        input: decision.input,
        answer: decision.answer,
        decidedBy: decision.decidedBy,
        createdAt: decision.createdAt,
        decidedAt: decision.decidedAt,
      };
    },
  };
}

/**
 * Registers the three read tools on `handlers`, skipping a name that already has a handler (a
 * test or a later step may bring its own).
 */
export function registerReadTools(handlers: ToolHandlers, store: ReadToolsStore): ToolHandlers {
  for (const [name, handler] of Object.entries(readToolHandlers(store))) {
    if (!handlers.has(name)) handlers.register(name, handler);
  }
  return handlers;
}
